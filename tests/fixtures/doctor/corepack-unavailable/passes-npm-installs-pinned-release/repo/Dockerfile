FROM node:26-alpine AS base
RUN npm install --global npm@11.19.1
FROM base AS deps
WORKDIR /app
COPY . .
RUN npm ci
