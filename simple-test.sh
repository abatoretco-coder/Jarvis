#!/bin/bash
API="http://localhost:8090"
THREAD_ID="window-$(date +%s)"

echo "Testing conversation window with threadId: $THREAD_ID"
echo ""
echo "Request 1..."
RESP1=$(curl -s -X POST $API/v1/ingest \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"Hello\",\"threadId\":\"$THREAD_ID\",\"channel\":\"test\"}")
echo "$RESP1"
echo ""
sleep 2
echo "Request 2 (should reuse thread)..."
RESP2=$(curl -s -X POST $API/v1/ingest \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"Hi again\",\"threadId\":\"$THREAD_ID\",\"channel\":\"test\"}")
echo "$RESP2"
