# Discoteca

App web autoalojada para organizar **álbumes completos** de Apple Music en colecciones y carpetas anidables. Apple Music solo permite carpetas de listas de reproducción, y sus listas convierten los discos en canciones sueltas. Aquí la unidad es el álbum, con su portada.

- Busca álbumes en el catálogo de Apple Music o pega un enlace.
- Organízalos en colecciones dentro de carpetas (por ejemplo, *Jazz › Modal*).
- Un mismo álbum puede estar en varias colecciones sin duplicarse.
- Importa tus listas de [Record Club](https://record.club) (o una lista en texto, CSV o Excel) como colecciones, emparejando cada disco con Apple Music.
- Ordena cada colección arrastrando los discos, o por artista, año, posición original o fecha.
- Al tocar una portada se abre el álbum en la app Música (iPhone y Mac). La app no reproduce música.
- Si un disco no está en Apple Music, puede enlazarse a su página de **Bandcamp**.
- Se instala en la pantalla de inicio del iPhone como una app (PWA), con modo oscuro.
- Copias de seguridad en JSON desde la propia app.
- Pensada para un solo usuario y protegida con una contraseña.

## Requisitos

- Docker y Docker Compose (o Portainer), **o** Node.js 22.13 o superior para ejecutarla sin Docker.
- No necesita claves de API: usa la iTunes Search API pública de Apple.

## Instalación con Docker Compose

```bash
git clone https://github.com/ForeverRamone/discoteca.git
cd discoteca
cp .env.example .env      # y edita APP_PASSWORD
docker compose up -d --build
```

Abre `http://IP-DEL-SERVIDOR:3000`.

## Instalación con Portainer

1. **Stacks › Add stack › Repository**, con la URL del repositorio de GitHub (Portainer construye la imagen con el `Dockerfile`).
2. En **Environment variables**, añade al menos `APP_PASSWORD`.
3. **Deploy the stack**.

La base de datos se guarda en el volumen `discoteca-data`, que sobrevive a actualizaciones y reinicios del contenedor.

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `APP_PASSWORD` | — | Contraseña de acceso. Obligatoria en Docker. Si está vacía (solo en local), la app no pide contraseña. |
| `SESSION_SECRET` | generado | Firma la cookie de sesión. Si no se define, se genera y se guarda en `/data/.session-secret`. |
| `ITUNES_COUNTRY` | `es` | Tienda de Apple Music (código de país). |
| `TRUST_PROXY` | vacío | Pon `true` si la app está detrás de un proxy inverso (Nginx Proxy Manager, Traefik, Caddy…) para que las cookies usen `Secure` con HTTPS. |
| `HOST_PORT` | `3000` | Puerto del host en `docker-compose.yml`. |
| `SESSION_DAYS` | `180` | Duración de la sesión. |
| `ITUNES_RATE_PER_MINUTE` | `20` | Peticiones por minuto a Apple (su límite orientativo). |
| `RC_DELAY_MS` | `700` | Pausa mínima entre peticiones a Record Club. |
| `AUTO_SYNC_HOURS` | `0` | Si es mayor que 0, las colecciones de Record Club se actualizan solas cada N horas (por ejemplo, `168` = semanal). |

Cambiar `APP_PASSWORD` cierra todas las sesiones abiertas.

## Desarrollo local

```bash
npm install
cp .env.example .env
npm run dev
```

La app queda en `http://localhost:3000` y los datos en `./data`.

## Instalar en el iPhone

1. Abre la app en **Safari** e inicia sesión.
2. Pulsa **Compartir › Añadir a pantalla de inicio**.

Se abrirá a pantalla completa, con su icono, como una app más. Para que además funcione sin conexión (mostrando la interfaz aunque el servidor no responda), la app debe servirse por **HTTPS**, por ejemplo tras un proxy inverso; en ese caso pon `TRUST_PROXY=true`. Por HTTP en tu red local también se instala, pero sin esa parte.

## Copia de seguridad

**Desde la app**, en **Ajustes › Copia de seguridad**:

- **Descargar copia (JSON)** guarda en un archivo todos tus álbumes, carpetas, colecciones (con su orden) y la memoria de emparejamientos. No incluye el historial de importaciones.
- **Restaurar desde archivo** sustituye todo el contenido por el de una copia. Antes, el servidor guarda automáticamente una copia de la base de datos actual en `/data/backups/` (se conservan las 10 últimas). Si el archivo está dañado, no se cambia nada.

**Desde el servidor:** todo está en un único archivo SQLite, `/data/discoteca.db`. Para copiarlo con el contenedor en marcha:

```bash
docker run --rm -v discoteca-data:/data -v "$PWD":/backup alpine \
  sh -c 'cp /data/discoteca.db /backup/discoteca-$(date +%F).db'
```

Si el nombre del volumen lleva el prefijo del stack, búscalo con `docker volume ls`.

## Ordenar las colecciones

Cada colección se puede ver en cuadrícula (con tamaño de portada ajustable) o en lista, y ordenar por **orden manual**, **posición original** (la de Record Club o la del archivo importado), artista, año, título o fecha de añadido.

Para cambiar el orden manual, pulsa **Reordenar**, arrastra los discos (en el móvil, mantén pulsado y arrastra) y pulsa **Guardar orden**.

## Abrir en Apple Music

En **Ajustes** puedes elegir, para cada dispositivo, cómo se abren los álbumes:

- `music://music.apple.com/...` abre directamente la app Música. Es lo recomendado en iPhone (sobre todo con la app instalada en la pantalla de inicio) y en Mac.
- `https://music.apple.com/...` es el enlace universal: el sistema decide si abre la app o la web.

Hay botones de prueba con *Kind of Blue* para comprobar cuál funciona mejor en cada dispositivo.

## Importar listas

En **Importar** puedes:

- **Pegar la URL de una lista pública de Record Club** (`https://record.club/usuario/lists/nombre`). Se crea una colección con su título, descripción y orden, y se recorren todas las páginas de la lista.
- **Pegar texto** con un disco por línea (`Artista – Álbum`, opcionalmente con el año entre paréntesis) o **subir un CSV o un Excel (.xlsx)** con columnas *Artista*, *Álbum*, *Año* y *Posición*.

Cada disco se empareja con Apple Music en este orden:

1. **Memoria:** si ya emparejaste ese disco en otra lista, se reutiliza.
2. **Enlace de Record Club:** muchos discos traen su enlace de Apple Music. Se valida en tu tienda; si Apple cambió el ID, se sigue la redirección.
3. **Búsqueda** por artista y título, con una puntuación que ignora acentos, mayúsculas, «The» y ediciones (*Deluxe*, *Remastered*, *Aniversario*…).
4. **Discografía del artista**, porque la búsqueda de Apple no siempre encuentra todos los discos.

Las coincidencias seguras se añaden solas. Las dudosas quedan en **Por revisar**, con las mejores opciones (portada, año, pistas y porcentaje de coincidencia): eliges una, buscas a mano o marcas «No está en Apple Music». Lo que confirmas se recuerda para otras listas. Los no encontrados se pueden exportar en CSV.

La importación corre en segundo plano (puedes cerrar la página) y se reanuda si el servidor se reinicia. Como referencia, una lista de 50 discos tarda 1-2 minutos; una de 800, unos 20-30.

### Varias listas a la vez

- Pega varias URL, una por línea.
- O escribe tu usuario de Record Club en **Tus listas de Record Club**, marca las que quieras y pulsa **Importar seleccionadas**.

Las importaciones se hacen de una en una, en segundo plano. Si una lista ya estaba importada, no se duplica: se actualiza.

### Mantener las listas al día

Cada colección importada recuerda su lista de origen. Para actualizarla:

- **Actualizar desde Record Club** en la página de la colección, o **Actualizar todas** en *Importar*.
- O automáticamente con `AUTO_SYNC_HOURS` (por ejemplo `168` para una vez por semana).

Al actualizar, solo se emparejan los **discos nuevos**; los que ya estaban conservan su emparejamiento. Si no has reordenado la colección a mano, los nuevos aparecen en su sitio según el orden de Record Club; si la has reordenado, se añaden al final. Los discos que se hayan quitado de la lista en Record Club se mantienen en la colección y se indican en el resumen de la actualización.

**Sobre Record Club:** no tiene una API pública documentada. La app usa la misma API JSON que su web (`api.record.club`), con pocas peticiones y espaciadas, solo para tus listas públicas. Si algún día cambia o la bloquean, usa la importación por texto o CSV.

## Discos que no están en Apple Music: Bandcamp

Si un disco no está en Apple Music, la app puede guardarlo con su página de Bandcamp. Esos discos llevan la etiqueta **Bandcamp** en la portada y, al tocarla, se abre su página (en el iPhone, en Safari: la app de Bandcamp no abre álbumes desde enlaces).

Al importar, cuando Apple Music no tiene nada parecido, la app busca el enlace de Bandcamp del disco:

1. en **Record Club**, que lo guarda en muchos discos;
2. si no, en **MusicBrainz**, la base de datos musical abierta (una petición por segundo, como pide su API).

Después visita esa página del álbum y solo lo asigna si el título y el artista coinciden. Si Apple tiene opciones dudosas, la de Bandcamp aparece como una más en **Por revisar**. En la revisión también puedes pulsar **Buscar en Bandcamp** (abre su buscador en tu navegador) y **Pegar enlace de Bandcamp**, y en **Buscar** puedes pegar el enlace de cualquier álbum de Bandcamp.

**Sobre Bandcamp:** no tiene API pública y su `robots.txt` no permite que los programas usen su buscador, así que la app **nunca busca en Bandcamp**. Solo lee la página de un álbum cuando ya conoce su URL: una petición por álbum, espaciada y guardada en caché durante 30 días. Las portadas se muestran desde los servidores de Bandcamp. Los discos de Bandcamp quedarían fuera si algún día se crean listas en Apple Music.

## Preparado para el futuro: listas reales en Apple Music

Cada álbum se guarda con su **ID de catálogo de Apple Music**, igual que cada emparejamiento confirmado. Con eso, una futura integración con la API de Apple Music (MusicKit, que requiere cuenta de desarrollador) podría crear listas reales en tu biblioteca a partir de tus colecciones sin volver a emparejar nada.

## Cómo funciona

- **Backend:** Node.js + Express. Base de datos SQLite (`node:sqlite`, incluida en Node, sin módulos nativos).
- **Frontend:** HTML, CSS y JavaScript sin paso de compilación. [SortableJS](https://github.com/SortableJS/Sortable) para arrastrar y soltar.
- **PWA:** manifiesto, iconos (generados con `node scripts/make-icons.mjs`) y un *service worker* que guarda la interfaz; los datos siempre van al servidor.
- **Datos de Apple:** iTunes Search API (`/search` y `/lookup`). Los metadatos de cada álbum guardado se almacenan localmente y las respuestas se cachean para respetar los límites de Apple.
- Si Apple ha sustituido un álbum por otro con un ID nuevo, la app sigue la redirección de `music.apple.com` para encontrar el actual.
- La búsqueda por texto de Apple no siempre encuentra todos los discos de un artista. Pulsa el nombre del artista en los resultados para ver su discografía completa.

## Licencia

[MIT](LICENSE).
