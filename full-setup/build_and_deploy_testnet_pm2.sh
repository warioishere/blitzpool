#!/bin/bash

set -e

# Configuration
COMPOSE_FILE="docker-compose-testnet-pm2.yml"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
NC="\033[0m"

cd "$SCRIPT_DIR"

echo -e "${GREEN}[*] Blitzpool Testnet PM2 - Build & Deploy${NC}"
echo ""

# Ensure data directories exist
echo -e "${YELLOW}[1/4] Creating data directories...${NC}"
mkdir -p data/testnet/bitcoin
mkdir -p data/testnet/public-pool
mkdir -p data/testnet/public-pool/redis
mkdir -p logs

# Check required files
echo -e "${YELLOW}[2/4] Checking required files...${NC}"
for f in "$COMPOSE_FILE" "bitcoin-testnet.conf" "blitzpool-testnet.env"; do
  if [[ ! -f "$f" ]]; then
    echo -e "${RED}[!] Missing required file: $f${NC}"
    exit 1
  fi
done

# Check bitcoin image exists
if ! docker image inspect my-bitcoin-image:latest >/dev/null 2>&1; then
  echo -e "${YELLOW}[*] Bitcoin image not found, building...${NC}"
  ./build_bitcoincore.sh
fi

# Build and deploy
echo -e "${YELLOW}[3/4] Building containers...${NC}"
docker compose -f "$COMPOSE_FILE" build

echo -e "${YELLOW}[4/4] Starting services...${NC}"
docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo -e "${GREEN}[✓] Testnet PM2 deployment complete${NC}"
echo -e "${GREEN}    Stratum:  0.0.0.0:3333${NC}"
echo -e "${GREEN}    API:      0.0.0.0:3334${NC}"
echo -e "${GREEN}    JDP:      0.0.0.0:3335${NC}"
echo -e "${GREEN}    Bitcoin:  127.0.0.1:18332 (RPC)${NC}"
echo ""
echo -e "Logs: ${YELLOW}docker compose -f $COMPOSE_FILE logs -f${NC}"
