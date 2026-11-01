FROM node:24.18.0-alpine
WORKDIR /app
RUN npm install -g npm@11.15.0
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["node", "server.js"]
