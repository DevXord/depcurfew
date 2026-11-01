ARG NODE=22
FROM node:${NODE} AS base
WORKDIR /app

FROM base AS deps
RUN npm install

FROM base AS upgraded
RUN npm install -g npm@11.19.1

FROM upgraded AS app
RUN npm ci
