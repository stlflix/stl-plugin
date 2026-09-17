FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
# `scripts/` are one-off operations run with `docker exec` against the live
# container, which already holds ADMIN_DB_URL. They are not part of the server.
COPY scripts ./scripts
USER node
EXPOSE 8200
CMD ["node", "src/server.js"]
