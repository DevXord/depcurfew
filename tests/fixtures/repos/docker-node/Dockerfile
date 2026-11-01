# syntax=docker/dockerfile:1
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM deps AS build
RUN npm install -g npm@11.17.0 \
 && npm run build

FROM gcr.io/distroless/nodejs22-debian12
COPY --from=build /app /app
