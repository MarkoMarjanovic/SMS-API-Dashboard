# Production image: builds the UI, then runs the API + scheduler as one long-lived process.
# Mount a persistent volume at /app/data (the SQLite database lives there).
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DATA_DIR=/app/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/client/dist ./client/dist
COPY package.json ./
COPY server ./server
COPY shared ./shared
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 4000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
