#!/bin/bash
set -e

API="http://localhost:8090"
THREAD_ID="window-test-$(date +%s)"

echo "🧪 Testing 10-second conversation window"
echo "Thread ID: $THREAD_ID"
echo ""

# Request 1: Create conversation
echo "📝 Request 1: Initial question"
RESPONSE1=$(curl -s -X POST $API/v1/ingest \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"Quel jour sommes-nous?\",\"threadId\":\"$THREAD_ID\",\"channel\":\"test\"}")

echo "$RESPONSE1" | jq '{threadId: .threadId, responseLength: (.responseText | length)}'
sleep 1

# Request 2: Follow-up within window
echo ""
echo "📝 Request 2: Follow-up within 10s"
RESPONSE2=$(curl -s -X POST $API/v1/ingest \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"Et l'heure?\",\"threadId\":\"$THREAD_ID\",\"channel\":\"test\"}")

RESPONSE2_THREAD=$(echo "$RESPONSE2" | jq -r '.threadId')
echo "Response threadId: $RESPONSE2_THREAD"
echo "$(echo "$RESPONSE2" | jq '{responseLength: (.responseText | length)}')"

# Check if reused
RESPONSE1_THREAD=$(echo "$RESPONSE1" | jq -r '.threadId')
if [ "$RESPONSE1_THREAD" = "$RESPONSE2_THREAD" ]; then
  echo "✅ Thread was REUSED (window still active)"
else
  echo "⚠️  Thread was NOT reused (got: $RESPONSE2_THREAD vs $RESPONSE1_THREAD)"
fi

echo ""
echo "📊 Checking logs for window reuse:"
docker logs home-assistant-jarvis-1 2>&1 | grep 'ingest_reusing_active_thread' | tail -3
