FROM node:26-alpine AS base
RUN npm install -g npm@11.18.0
FROM base AS deps
WORKDIR /app
COPY . .
RUN npm ci
