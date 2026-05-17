#!/bin/bash
# Test script for conversation window feature (10 seconds)

API_URL="http://192.168.1.38:8090"
API_KEY="${JARVIS_API_KEY:-}"

# Generate a unique thread ID for this test
THREAD_ID="test-$(date +%s)-$$"
echo "🧪 Testing conversation window with threadId: $THREAD_ID"
echo ""

# Test 1: First request (should create new thread)
echo "[1/3] First request (should create new thread)..."
RESPONSE1=$(curl -s -X POST "$API_URL/v1/ingest" \
  -H "Content-Type: application/json" \
  ${API_KEY:+-H "X-API-Key: $API_KEY"} \
  -d "{
    \"text\": \"Quelle est la météo?\",
    \"threadId\": \"$THREAD_ID\",
    \"channel\": \"test\"
  }")

THREAD_ID_RESPONSE=$(echo "$RESPONSE1" | jq -r '.threadId // empty')
echo "Response threadId: $THREAD_ID_RESPONSE"
echo "First 100 chars: $(echo "$RESPONSE1" | jq '.responseText' | cut -c1-100)"
sleep 1

# Test 2: Immediate follow-up (should reuse thread within 10s window)
echo ""
echo "[2/3] Immediate follow-up within 10s window (should reuse thread)..."
RESPONSE2=$(curl -s -X POST "$API_URL/v1/ingest" \
  -H "Content-Type: application/json" \
  ${API_KEY:+-H "X-API-Key: $API_KEY"} \
  -d "{
    \"text\": \"Et demain?\",
    \"threadId\": \"$THREAD_ID\",
    \"channel\": \"test\"
  }")

THREAD_ID_RESPONSE2=$(echo "$RESPONSE2" | jq -r '.threadId // empty')
echo "Response threadId: $THREAD_ID_RESPONSE2"
echo "First 100 chars: $(echo "$RESPONSE2" | jq '.responseText' | cut -c1-100)"
sleep 1

# Test 3: After 10s window expires (should create new thread)
echo ""
echo "[3/3] Waiting 11s for window to expire..."
sleep 11

echo "New request after window expiry (should create new thread)..."
RESPONSE3=$(curl -s -X POST "$API_URL/v1/ingest" \
  -H "Content-Type: application/json" \
  ${API_KEY:+-H "X-API-Key: $API_KEY"} \
  -d "{
    \"text\": \"Comment est le vent?\",
    \"threadId\": \"$THREAD_ID\",
    \"channel\": \"test\"
  }")

THREAD_ID_RESPONSE3=$(echo "$RESPONSE3" | jq -r '.threadId // empty')
echo "Response threadId: $THREAD_ID_RESPONSE3"
echo "First 100 chars: $(echo "$RESPONSE3" | jq '.responseText' | cut -c1-100)"

# Analyze results
echo ""
echo "📊 Test Results:"
echo "  Request 1 threadId: $THREAD_ID_RESPONSE"
echo "  Request 2 threadId: $THREAD_ID_RESPONSE2"  
echo "  Request 3 threadId: $THREAD_ID_RESPONSE3"

if [ "$THREAD_ID_RESPONSE" = "$THREAD_ID_RESPONSE2" ]; then
  echo "✅ Request 2 reused thread (window active)"
else
  echo "❌ Request 2 did NOT reuse thread"
fi

if [ "$THREAD_ID_RESPONSE2" != "$THREAD_ID_RESPONSE3" ] || [ "$THREAD_ID_RESPONSE" != "$THREAD_ID_RESPONSE3" ]; then
  echo "✅ Request 3 created new thread (window expired)"
else
  echo "❌ Request 3 did NOT create new thread"
fi

# Show logs
echo ""
echo "📜 Backend logs with 'reusing':"
ssh loic@192.168.1.38 "docker logs -f home-assistant-jarvis-1 2>&1 | grep -E 'ingest_reusing_active_thread' | tail -5" &
sleep 3
kill %1 2>/dev/null
