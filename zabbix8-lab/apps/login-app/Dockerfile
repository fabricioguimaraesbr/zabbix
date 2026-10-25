FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "--require", "./instrumentation.cjs", "app.cjs"]
