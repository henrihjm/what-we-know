FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm i -g tsx
COPY . .
RUN mkdir -p state out/cards tickets
ENV NODE_ENV=production
# Override with: docker run ... npm run loop:hormuz  /  npm run dashboard
CMD ["npm", "run", "loop"]
