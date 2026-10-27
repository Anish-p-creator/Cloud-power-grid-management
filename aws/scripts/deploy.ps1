<#
  GridSync - one-command deployment to AWS.
  Usage (from the repository root):
    powershell -ExecutionPolicy Bypass -File aws\scripts\deploy.ps1 -BudgetEmail you@example.com
  Steps: train + export models -> package Lambda -> CloudFormation stack ->
         IoT things + X.509 certificates -> website to S3/CloudFront.
#>
param(
  [Parameter(Mandatory = $true)][string]$BudgetEmail,
  [string]$Region = "ap-southeast-2",
  [string]$StackName = "gridsync"
)

$ErrorActionPreference = "Continue"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$aws = (Get-Command aws -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe" }

function Invoke-Aws {
  $out = & $aws @args --region $Region 2>&1
  if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed:`n$out" }
  return $out
}
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Step "Checking AWS identity"
$account = (Invoke-Aws sts get-caller-identity --query Account --output text).Trim()
Write-Host "Account $account, region $Region"

Step "Artifact bucket"
$artifacts = "gridsync-artifacts-$account-$Region"
& $aws s3api head-bucket --bucket $artifacts --region $Region 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Invoke-Aws s3api create-bucket --bucket $artifacts --create-bucket-configuration "LocationConstraint=$Region" | Out-Null
  Invoke-Aws s3api put-public-access-block --bucket $artifacts --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" | Out-Null
  Write-Host "Created s3://$artifacts"
} else { Write-Host "Using s3://$artifacts" }

Step "Training models (SageMaker-equivalent job, run locally) and packaging Lambda"
node "$root\aws\scripts\export-models.js"
if ($LASTEXITCODE -ne 0) { throw "Model export failed" }
Copy-Item "$root\ml.js", "$root\ai.js" "$root\aws\lambda\" -Force
New-Item -ItemType Directory -Force "$root\aws\build" | Out-Null
$zip = "$root\aws\build\lambda.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$root\aws\lambda\*" -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
$codeKey = "lambda/gridsync-$hash.zip"
Invoke-Aws s3 cp $zip "s3://$artifacts/$codeKey" | Out-Null
Invoke-Aws s3 cp "$root\aws\lambda\models.json" "s3://$artifacts/models/models.json" | Out-Null
Write-Host "Uploaded $codeKey and the model artifact"

Step "IoT Core data endpoint"
$iotEndpoint = (Invoke-Aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text).Trim()
Write-Host $iotEndpoint

Step "Deploying CloudFormation stack '$StackName' (first run takes ~5-8 min for CloudFront)"
& $aws cloudformation deploy --region $Region --stack-name $StackName --template-file "$root\aws\template.yaml" `
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset `
  --parameter-overrides "ArtifactBucket=$artifacts" "CodeKey=$codeKey" "IotDataEndpoint=$iotEndpoint" "BudgetEmail=$BudgetEmail"
if ($LASTEXITCODE -ne 0) {
  Invoke-Aws cloudformation describe-stack-events --stack-name $StackName --max-items 15 `
    --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason]" --output table
  throw "Stack deployment failed"
}
$outputs = Invoke-Aws cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
$o = @{}; $outputs | ForEach-Object { $o[$_.OutputKey] = $_.OutputValue }

Step "Provisioning IoT things with X.509 certificates (mTLS)"
$certRoot = "$root\sim\certs"
New-Item -ItemType Directory -Force $certRoot | Out-Null
if (-not (Test-Path "$certRoot\AmazonRootCA1.pem")) {
  Invoke-WebRequest -UseBasicParsing "https://www.amazontrust.com/repository/AmazonRootCA1.pem" -OutFile "$certRoot\AmazonRootCA1.pem"
}
$things = @(1..8 | ForEach-Object { "charger-{0:d2}" -f $_ }) + "transformer-01"
foreach ($t in $things) {
  $dir = "$certRoot\$t"
  if (Test-Path "$dir\cert.pem") { Write-Host "$t already provisioned"; continue }
  New-Item -ItemType Directory -Force $dir | Out-Null
  & $aws iot create-thing --thing-name $t --region $Region 2>$null | Out-Null
  $certArn = (Invoke-Aws iot create-keys-and-certificate --set-as-active `
      --certificate-pem-outfile "$dir\cert.pem" --private-key-outfile "$dir\private.key" `
      --query certificateArn --output text).Trim()
  Invoke-Aws iot attach-policy --policy-name gridsync-device-policy --target $certArn | Out-Null
  Invoke-Aws iot attach-thing-principal --thing-name $t --principal $certArn | Out-Null
  Write-Host "$t -> $($certArn.Split('/')[-1].Substring(0,12))..."
}

Step "Writing config and publishing the website"
$cfg = @{ apiUrl = $o.ApiUrl; region = $Region; iotEndpoint = $iotEndpoint; websiteUrl = $o.WebsiteUrl } | ConvertTo-Json
Set-Content -Path "$root\config.json" -Value $cfg -Encoding ascii
Set-Content -Path "$root\sim\config.json" -Value $cfg -Encoding ascii
foreach ($f in "index.html", "styles.css", "app.js", "ml.js", "ai.js", "aws-live.js", "config.json") {
  Invoke-Aws s3 cp "$root\$f" "s3://$($o.WebsiteBucketName)/$f" | Out-Null
}

Write-Host "`nGridSync is deployed." -ForegroundColor Green
Write-Host "  Dashboard : $($o.WebsiteUrl)"
Write-Host "  API       : $($o.ApiUrl)"
Write-Host "  CloudWatch: $($o.CloudWatchDashboard)"
Write-Host "Start the chargers with:  cd sim; npm install; node charger-sim.js"
