FROM node:24-alpine
WORKDIR /app
COPY runtime/src/safety.mjs /app/runtime/src/safety.mjs
COPY tunnel/gateway.mjs /app/tunnel/gateway.mjs
EXPOSE 8080
CMD ["node", "tunnel/gateway.mjs"]
