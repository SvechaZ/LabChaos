FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# ติดตั้งแพ็กเกจก่อนคัดลอกโค้ด แก้โค้ดแล้ว build ใหม่จะไม่ต้องลงแพ็กเกจซ้ำ
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# ไม่รันด้วย root ผู้ใช้ node มากับ image อยู่แล้ว
USER node

EXPOSE 8080
CMD ["node", "src/server.js"]
