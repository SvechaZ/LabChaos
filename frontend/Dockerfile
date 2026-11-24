# ขั้นที่ 1: ใช้ npm ดึงไฟล์ฟอนต์ตามเวอร์ชันใน package-lock.json
FROM node:22-alpine AS fonts
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci

# ขั้นที่ 2: image จริงมีแค่ nginx กับไฟล์หน้าเว็บ ไม่มี Node
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
COPY --from=fonts /build/node_modules/@fontsource /usr/share/nginx/html/fonts

EXPOSE 80
