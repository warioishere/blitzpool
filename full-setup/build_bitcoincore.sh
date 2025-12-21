#!/bin/bash

set -e

# Configuration
IMAGE_NAME="my-bitcoin-image"
IMAGE_TAG="latest"
BUILD_CONTEXT="./docker/bitcoin"
DOCKERFILE_PATH="$BUILD_CONTEXT/Dockerfile"

# Colors
GREEN="\033[1;32m"
RED="\033[1;31m"
NC="\033[0m"

echo -e "${GREEN}[*] Starting build for ${IMAGE_NAME}:${IMAGE_TAG}${NC}"

# Check if Dockerfile exists
if [[ ! -f "$DOCKERFILE_PATH" ]]; then
  echo -e "${RED}[!] Dockerfile not found at: $DOCKERFILE_PATH${NC}"
  exit 1
fi

# Build the Docker image
docker build \
  --file "$DOCKERFILE_PATH" \
  --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
  "$BUILD_CONTEXT"

echo -e "${GREEN}[✓] Build complete: ${IMAGE_NAME}:${IMAGE_TAG}${NC}"
