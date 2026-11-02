FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
RUN mkdir /data && chown node:node /data
ENV PORT=8787 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.js"]
