FROM node:26-alpine AS base
WORKDIR /app
COPY . .
FROM base AS deps
RUN yarn install --immutable
