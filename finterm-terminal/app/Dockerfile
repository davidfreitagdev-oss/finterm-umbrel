# Optional: build your own image instead of mounting the code into node:22-alpine.
#   docker build -t finterm ./finterm-terminal/app
#   docker run -d -p 8420:8420 -v finterm-data:/data --name finterm finterm
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=8420 DATA_DIR=/data NODE_ENV=production TZ=Europe/Prague
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8420
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8420/api/status >/dev/null || exit 1
CMD ["node", "server.js"]
