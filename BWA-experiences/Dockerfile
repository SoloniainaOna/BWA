FROM nginx:alpine

# Supprimer la config nginx par défaut
RUN rm /etc/nginx/conf.d/default.conf

# Copier notre config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copier tout le code (sans les vidéos — elles sont montées en volume)
COPY html/ /usr/share/nginx/html/

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
