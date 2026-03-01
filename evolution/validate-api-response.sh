#!/bin/bash
# Validate API response from stdin
# Exit 0 if valid, exit 1 if garbage

INPUT=$(cat)

# Check valid JSON
echo "$INPUT" | jq . >/dev/null 2>&1 || { echo "FAIL: invalid JSON"; exit 1; }

# Check for choices (OpenAI) or candidates (Gemini)
HAS_CHOICES=$(echo "$INPUT" | jq 'has("choices")' 2>/dev/null)
HAS_CANDIDATES=$(echo "$INPUT" | jq 'has("candidates")' 2>/dev/null)

if [ "$HAS_CHOICES" = "true" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.choices[0].message.content // ""' 2>/dev/null)
elif [ "$HAS_CANDIDATES" = "true" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.candidates[0].content.parts[0].text // ""' 2>/dev/null)
else
  echo "FAIL: no choices or candidates array"; exit 1
fi

# Check content length >50 chars
LEN=${#CONTENT}
if [ "$LEN" -le 50 ]; then
  echo "FAIL: content too short ($LEN chars)"; exit 1
fi

echo "OK: valid response ($LEN chars)"
exit 0
