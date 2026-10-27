<#
  GridSync - delete everything this project created in AWS.
  Usage: powershell -ExecutionPolicy Bypass -File aws\scripts\teardown.ps1
#>
param([string]$Region = "ap-southeast-2", [string]$StackName = "gridsync")

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$aws = (Get-Command aws -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe" }
$account = (& $aws sts get-caller-identity --query Account --output text).Trim()

Write-Host "==> Removing IoT things and certificates"
$things = @(1..8 | ForEach-Object { "charger-{0:d2}" -f $_ }) + "transformer-01"
foreach ($t in $things) {
  $principals = & $aws iot list-thing-principals --thing-name $t --region $Region --query principals --output text 2>$null
  if ($LASTEXITCODE -ne 0) { continue }
  foreach ($arn in ($principals -split "\s+" | Where-Object { $_ })) {
    $id = $arn.Split("/")[-1]
    & $aws iot detach-thing-principal --thing-name $t --principal $arn --region $Region | Out-Null
    & $aws iot detach-policy --policy-name gridsync-device-policy --target $arn --region $Region | Out-Null
    & $aws iot update-certificate --certificate-id $id --new-status INACTIVE --region $Region | Out-Null
    & $aws iot delete-certificate --certificate-id $id --region $Region | Out-Null
  }
  & $aws iot delete-thing --thing-name $t --region $Region | Out-Null
  Write-Host "  deleted $t"
}

Write-Host "==> Emptying website bucket"
& $aws s3 rm "s3://gridsync-web-$account-$Region" --recursive --region $Region | Out-Null

Write-Host "==> Deleting CloudFormation stack (CloudFront removal can take ~5 min)"
& $aws cloudformation delete-stack --stack-name $StackName --region $Region
& $aws cloudformation wait stack-delete-complete --stack-name $StackName --region $Region

Write-Host "==> Deleting artifact bucket"
& $aws s3 rb "s3://gridsync-artifacts-$account-$Region" --force --region $Region | Out-Null

Remove-Item -Recurse -Force "$root\sim\certs" -ErrorAction SilentlyContinue
Write-Host "Done. Nothing from GridSync remains in your account." -ForegroundColor Green
