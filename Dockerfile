# Review Rally – kleiner Team-Server, keine npm-Abhängigkeiten
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

# Nur die zwei Dateien, die der Server wirklich braucht
COPY server.js index.html ./

# Datenverzeichnis für state.json – im Cluster hier das PersistentVolume mounten
RUN mkdir -p /data && chown node:node /data

# Nicht als root laufen (der Benutzer "node" hat UID/GID 1000)
USER node

EXPOSE 3000
VOLUME ["/data"]

# server.js reagiert selbst auf SIGTERM und fährt sauber herunter
CMD ["node", "server.js"]
