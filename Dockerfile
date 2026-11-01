# Node runs the TypeScript sources directly, and the app has no runtime npm
# dependencies, so the image is just Node plus the source and map data.
FROM node:26-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STATE_DIR=/app/state

COPY package.json ./
COPY src ./src
COPY public ./public
# Built map data (stations, track, TfL lines). CORPUS and the timetable are
# downloaded at runtime into the state volume, with the NROD account.
COPY data/stations.json data/track.json.gz data/tfl.json data/tfl-track.json.gz ./data/

RUN mkdir -p /app/state && chown node:node /app/state
USER node
VOLUME /app/state

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/status" > /dev/null || exit 1

# node is PID 1: it gets docker stop's SIGTERM and saves its trains first.
CMD ["node", "src/server.ts"]
