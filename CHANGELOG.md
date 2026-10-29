# Cambios

## 0.2.0

### Novedades
- **Escuchado, valoración y notas** en la ficha de cada disco, con marcas en la cuadrícula, filtro *Pendientes / Escuchados* y órdenes por valoración y por escuchados recientemente.
- **Disco al azar** entre los que estás viendo (respeta los filtros).
- **Filtro de texto también dentro de cada colección**; en la Biblioteca, filtro *En varias colecciones*.
- **Colecciones:** editar la descripción, duplicar y exportar a CSV o texto (se pueden volver a importar).
- **Deshacer** al quitar un disco de una colección (recupera su sitio y su posición original).
- Ficha del álbum en dos columnas en pantallas anchas; el artista enlaza a su discografía.
- Atajo `/` para buscar y `Esc` para salir de reordenar.

### Usabilidad y accesibilidad
- Aviso con «Reintentar» si la app arranca sin conexión (antes, pantalla en blanco) y si falla una búsqueda (antes decía «Sin resultados»).
- Indicador de carga al cambiar de pantalla, foco en el título, barra lateral que despliega la carpeta abierta.
- Contraste AA en botones y estados; botones más grandes en pantallas táctiles.
- El menú lateral cerrado ya no se recorre con el teclado ni con VoiceOver.

### Fallos corregidos
- Restaurar una copia recarga los datos (antes seguían viéndose los antiguos).
- No se pierde el orden sin guardar al volver a la app; los cambios recibidos mientras reordenas se aplican al terminar.
- Búsquedas seguidas ya no muestran resultados de la anterior; los diálogos se cierran al ir atrás.
- Exportar con emojis en el nombre, fechas imposibles, cookies o URL mal codificadas ya no dan error 500.
- Un disco que falla ya no tumba la importación; si Apple está caído, la importación se detiene y al reintentar vuelve a procesar esos discos.
- La misma lista enviada dos veces no se importa dos veces; reintentar una actualización vuelve a leer la lista; la actualización automática no repite errores cada 30 minutos.
- Excel con filas solo con formato ya no se rechaza.

### Seguridad
- Un Excel manipulado de pocos bytes ya no puede tumbar ni bloquear el servidor.
- `TRUST_PROXY=true` equivale a un salto de proxy, para que no se pueda falsear la IP. Límite de intentos de contraseña por IP (IPv6 por /64) y freno global que no deja fuera al dueño.
- Bandcamp: las redirecciones no pueden llevar a direcciones de la red interna (también por DNS) y las respuestas tienen tamaño máximo.
- Copias de seguridad con carpetas en ciclo se rechazan (antes colgaban el servidor).
- La caché ya no guarda respuestas que no son JSON; cachés en memoria con tope y purga periódica.

**Nota al actualizar:** si usas Cloudflare delante de tu proxy inverso, pon en `TRUST_PROXY` el número de saltos correcto (por ejemplo `2`).
