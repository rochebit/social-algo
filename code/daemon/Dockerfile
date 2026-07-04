# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ gcc
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Run stage
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache sqlite
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 8080
CMD ["npm", "start"]
