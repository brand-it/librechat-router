FROM node:22-alpine
WORKDIR /app
COPY server.js /app/server.js
ENV PORT=3081
EXPOSE 3081
CMD ["node", "/app/server.js"]
