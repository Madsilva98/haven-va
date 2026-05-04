FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY scripts/ ./scripts/
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
