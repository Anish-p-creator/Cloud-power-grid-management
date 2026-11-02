#!/usr/bin/env bash
# Resets the live demo state: re-activates every charger certificate, re-attaches the device
# policy, closes all bay contactors, zeroes the threat counter and clears the event log.
# Usage: bash aws/scripts/reset-demo.sh
set -u
R=ap-southeast-2
export PATH="$PATH:/c/Program Files/Amazon/AWSCLIV2"
for t in charger-01 charger-02 charger-03 charger-04 charger-05 charger-06 charger-07 charger-08; do
  arn=$(aws iot list-thing-principals --thing-name $t --region $R --query "principals[0]" --output text)
  id=${arn##*/}
  if [ "$(aws iot describe-certificate --certificate-id "$id" --region $R --query certificateDescription.status --output text)" != "ACTIVE" ]; then
    aws iot update-certificate --certificate-id "$id" --new-status ACTIVE --region $R
    echo "re-activated $t"
  fi
  aws iot attach-policy --policy-name gridsync-device-policy --target "$arn" --region $R
  aws dynamodb update-item --region $R --table-name gridsync-charger-state --key "{\"deviceId\":{\"S\":\"$t\"}}" \
    --update-expression "SET #s = :a, flags = :f" --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values '{":a":{"S":"ACTIVE"},":f":{"L":[]}}' >/dev/null
  aws iot-data publish --region $R --topic gridsync/transformer-01/cmd --cli-binary-format raw-in-base64-out \
    --payload "{\"action\":\"ReconnectBay\",\"deviceId\":\"$t\"}"
done
aws iot-data publish --region $R --topic gridsync/sim/demo --cli-binary-format raw-in-base64-out --payload '{"action":"restore"}'
aws dynamodb update-item --region $R --table-name gridsync-site --key '{"pk":{"S":"site"},"sk":{"S":"state"}}' \
  --update-expression "SET threats = :z" --expression-attribute-values '{":z":{"N":"0"}}'
n=0
for sk in $(aws dynamodb query --region $R --table-name gridsync-site --key-condition-expression "pk = :p" \
    --expression-attribute-values '{":p":{"S":"event"}}' --projection-expression sk --query "Items[].sk.S" --output text); do
  aws dynamodb delete-item --region $R --table-name gridsync-site --key "{\"pk\":{\"S\":\"event\"},\"sk\":{\"S\":\"$sk\"}}"
  n=$((n+1))
done
echo "cleared $n events; inactive certificates now: $(aws iot list-certificates --region $R --query "certificates[?status=='INACTIVE'] | length(@)" --output text)"
