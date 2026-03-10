#!/usr/bin/env bash
# bin/load-credentials.sh — Source API keys from standard locations

if [ -f "$HOME/.env.anthropic" ]; then
  export ANTHROPIC_API_KEY=$(cat "$HOME/.env.anthropic")
fi

# Add more credential sources as needed per persona
