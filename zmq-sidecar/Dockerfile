FROM node:22-alpine

WORKDIR /sidecar

# zeromq needs libstdc++ from the cargo runtime; node:alpine has it.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json index.ts ./

CMD ["npx", "tsx", "index.ts"]
