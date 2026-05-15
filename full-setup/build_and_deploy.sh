#!/bin/bash
set -e

COMPOSE_FILE="docker-compose-mainnet-pg.yml"

GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${GREEN}[*] Blitzpool - Build & Deploy (PostgreSQL)${NC}"

cd "$(dirname "$0")"

echo -e "${GREEN}[1/2] Building image...${NC}"
docker compose -f "$COMPOSE_FILE" build public-pool

echo -e "${GREEN}[2/2] Replacing container...${NC}"
docker compose -f "$COMPOSE_FILE" up -d public-pool

echo -e "${GREEN}[✓] Deployment complete${NC}"
echo ""
echo "Logs: docker compose -f $COMPOSE_FILE logs -f public-pool"
