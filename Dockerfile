# Sert l'application Zinguerie Provençale en statique via nginx
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
EXPOSE 80
