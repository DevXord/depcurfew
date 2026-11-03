FROM node:24 AS build
ARG npm_config_min_release_age=1
ENV npm_config_allow_remote=all
COPY . .
RUN npm_config_min_release_age=0 npm ci
