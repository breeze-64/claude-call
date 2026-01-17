#!/bin/bash

# Claude-Call Start Script
# Starts the authorization server

cd "$(dirname "$0")/.."

# Load environment variables
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

echo "Starting Claude-Call server..."
bun run start
