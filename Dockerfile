FROM node:90-noexiste
WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/index.js"]