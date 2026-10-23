# Mesa de Ayuda + Proyectos

Sistema de tickets al estilo Desk365 con gestión de proyectos tipo Jira. Vanilla JS + una sola función serverless en Vercel + Neon (Postgres).

## Qué incluye

**Mesa de ayuda**
- Vistas: Todos, Mis abiertos y pendientes, Sin asignar y mis abiertos, Que sigo, Sin resolver, SLA vencido, Resueltos y cerrados, Spam, Papelera + vistas personalizadas (propias o compartidas).
- Listado con orden, búsqueda, filtros, edición en línea (prioridad, estado, asignado), acciones masivas y exportación CSV.
- Ticket: conversación, respuesta por correo, notas privadas con menciones, reenvío, adjuntos, respuestas predefinidas, seguir, combinar, spam/papelera, registros de tiempo, historial de actividades.
- Campos: SLA, Estado, Prioridad, Categoría técnica y **subcategoría técnica** (dependiente de la categoría), Tipo, Asignado, Área solicitante, Etiquetas, CC. El superadmin puede cambiar el nombre de cada campo.
- SLA por prioridad con horario laboral, feriados y pausa en estados "en espera".
- Reglas de automatización al crear tickets.
- Contactos y empresas (importación CSV), base de conocimiento, panel e informes por agente/categoría técnica/área/canal.
- Portal público (`/portal`): crear tickets, seguirlos y responder, artículos. Usa el trato de "usted".
- Correo entrante por webhook (Power Automate) y saliente por Resend. Hilo por `[#número]` en el asunto.
- Notificaciones en la app y tarea diaria (autocierre de resueltos y aviso de SLA vencido).

**Proyectos**
- Proyectos con clave (CRM-123), flujo de estados configurable con límites WIP.
- Épicas, historias, tareas, bugs y subtareas; vínculos (bloquea / relacionada / duplica).
- Backlog con sprints (crear, iniciar, completar moviendo pendientes), tablero kanban con arrastrar y soltar, vista lista, roadmap de épicas.
- Informes: burndown, velocidad, distribución por estado, carga por responsable.
- Ticket ↔ tarea: desde un ticket se crea o vincula una tarea del proyecto.
- **Ticket → proyecto de desarrollo**: cuando un pedido es un desarrollo, el botón "Convertir en proyecto" crea el proyecto con una épica por etapa según el tipo elegido (por defecto, Desarrollo de software: Relevamiento y análisis, Desarrollo, Testing, Implementación; editables), copia la descripción, toma el área y la prioridad del ticket y reparte las fechas. El estado del ticket no cambia salvo que lo definas en **Configuración → Proyectos y portfolio**, donde se configuran las reglas de negocio: estado al convertir, al arrancar, al entrar en una fase determinada y al terminar; pausa del SLA mientras dura el desarrollo y avisos al solicitante por cambio de fase o fin. El ticket muestra las fases con su avance (hecha / en curso / pendiente, % y tareas), la fase actual y el avance total; el solicitante ve el mismo resumen en el portal. Cuando se completan todas las fases se avisa al responsable del ticket.
- "Mi trabajo": tickets y tareas asignadas.

**Tablero de control del agente (v1.4)**
- Inicio con alertas: tickets con más de N días, SLA vencido o que vence hoy, y usuarios que respondieron y esperan respuesta.
- Indicadores: abiertos, antigüedad promedio, SLA vencido, sin actividad, esperando al usuario, resueltos en la semana.
- Gráfico de antigüedad con cortes y colores configurables, **mis tickets más viejos** y **mis tickets más importantes** (puntaje con motivos: prioridad, SLA, espera, VIP, reaperturas, antigüedad, seguidores).
- "Mis tickets" o "Todo el equipo"; los supervisores pueden ver el tablero de cada agente. Se configura en **Configuración → Alertas de antigüedad**.

**Inteligencia artificial (v1.4)** — Claude, Gemini o Azure OpenAI, clave en Vercel (`AI_API_KEY`)
- **Copiloto del agente** en el ticket: resumen, clasificación sugerida con "Aplicar", pasos, tickets parecidos y artículos, preguntas libres y **borrador de respuesta** (más corta, más formal, más cercana, regenerar). Las respuestas redactadas con IA quedan marcadas.
- **Portal**: mientras el usuario escribe, "Antes de enviar, pruebe esto". Si se resuelve, no se crea el ticket y se cuenta como autoservicio.
- **Primera respuesta automática** al crear el ticket (portal y/o correo), con "¿Le sirvió?". Si dice que sí, la regla decide si se resuelve o queda abierto; si dice que no, se avisa al agente. Si el usuario ya probó las sugerencias del portal, la IA propone los pasos siguientes en lugar de repetirlos.
- **Reglas configurables**: palabras clave, categoría técnica o área → guía, modo (texto fijo, guía + IA, generada por IA), artículos y qué hacer si el usuario confirma. Exclusiones: prioridad, área, VIP, otro ticket abierto del mismo tema.
- **Prompts editables** con variables (`{ticket.asunto}`, `{historial}`, `{articulos}`…), banco de pruebas, tope mensual y consumo.
- Sin `AI_API_KEY` todo sigue funcionando con las guías de texto fijo; el copiloto muestra tickets parecidos y artículos.

**Microsoft 365 (v1.4)** — Configuración → Microsoft 365
- Inicio de sesión con Entra ID (opción "solo Microsoft" y grupo requerido).
- **Buzón de soporte por Microsoft Graph**: lee ayuda@, crea o agrega a tickets, mueve a "Procesados" y envía las respuestas desde el mismo buzón. Reemplaza a Power Automate.
- **Directorio**: empleados como contactos (área, cargo, teléfono, jefe), bajas desactivadas, agentes desde un grupo.
- **Teams**: avisos de urgentes, sin asignar y resumen de SLA vencidos por webhook de Workflows.
- **Intune**: equipos del solicitante en el ticket (sistema, cumplimiento, último contacto) y acciones remotas opcionales con auditoría.
- **SharePoint**: adjuntos en una biblioteca en lugar de la base.
- Prueba de conexión, tabla de permisos concedidos y registro de actividad.

**Seguridad (v1.5)** — detalle punto por punto en [SECURITY.md](SECURITY.md)
- Passkeys (WebAuthn), claves con Argon2id, sesiones opacas del lado del servidor, Microsoft con PKCE.
- Validación de toda entrada, SQL siempre parametrizado, HTML sanitizado, CSP estricta y protección CSRF.
- Rate limit en login y portal, 429 con `Retry-After` ante saturación, idempotencia en altas y mensajes.
- Transacciones con efectos externos después del commit, pool de conexiones, timeouts y reintentos selectivos.
- Migraciones versionadas (expandir/contraer), logs JSON con request id y `GET /api/health`.

**Tipos de proyecto, portfolio y roadmap (v1.6)**
- **Tipos de proyecto** (Configuración → Proyectos y portfolio): cada tipo tiene su plantilla de etapas, su flujo de tareas y si usa sprints. Vienen cargados Desarrollo de software (Relevamiento y análisis → Desarrollo → Testing → Implementación), Instalación de sistema (Análisis → Instalación → Implementación), Infraestructura y Capacitación; se pueden agregar otros. Al crear un proyecto (o convertir un ticket) se elige el tipo y se pueden destildar, renombrar, ordenar o agregar etapas. Los tipos sin sprints no muestran el backlog.
- **Etapas con avance**: cada etapa es una épica con fechas, responsable y estado. El avance sale de sus tareas hechas o, si no tiene tareas (por ejemplo, el dictado de una capacitación), del porcentaje que se carga en la pestaña Roadmap del proyecto.
- **Portfolio** (`#/portfolio`): el listado de todos los proyectos con las columnas de la planilla de IT (origen, sector IT, área, responsable, estado, prioridad, fechas, horas estimadas y registradas, avance) y su salud (en término, en riesgo, atrasado). Filtros, agrupación y orden. El avance es automático y se puede pisar a mano.
- **Roadmap**: los proyectos en el calendario (trimestre, semestre, año o todo), agrupados por sector o área, con la línea de hoy, el avance dentro de cada barra, las etapas desplegables, los recurrentes y la lista de los que no tienen fechas.
- **Excel**: importación de la planilla actual (vista previa antes de guardar, reconoce encabezados abreviados, responsables por apellido y crea los orígenes o sectores que falten) y exportación a .xlsx con dos hojas (proyectos y etapas).
- **Permiso "Ver portfolio"**: lo asigna el superadmin en Configuración → Agentes. Quien solo tiene ese permiso edita los datos del portfolio pero no puede cambiar el líder, archivar ni borrar proyectos.

**API de exportación (v1.6)** — Configuración → Superadmin → API
- Solo lectura en `/api/v1`: `tickets`, `tickets/{número}` (con la conversación), `projects`, `projects/{clave}`, `phases`, `issues`, `time-entries` y `catalog`. Documentación OpenAPI en `/api/v1/openapi.json`.
- Claves que crea el superadmin, con permisos por tema (tickets, proyectos, horas), vencimiento, registro de uso y revocación. En la base queda solo el hash; la clave se muestra una vez.
- Paginación por cursor (`next_cursor`), sincronización incremental con `updated_since`, salida JSON o CSV (`format=csv`) y límite de pedidos por clave.
- Power BI: Obtener datos → Web → Avanzado, con el encabezado `Authorization: Bearer <clave>`.

**Importar tickets de Desk365 (v1.6.1)** — Configuración → Importar datos
- Se sube el CSV (o Excel) que exporta Desk365 desde Todos los tickets → Exportar. Vista previa antes de guardar; se puede repetir sin duplicar.
- Conserva el número de cada ticket (los nuevos siguen después del más alto), asunto, descripción, estado, prioridad, origen, grupo (pasa a la categoría técnica), agente, área, tipo, fechas (hora de Buenos Aires) y tiempo registrado. Reconoce encabezados en español o inglés.
- La exportación de Desk365 no incluye las respuestas ni las notas: cada ticket queda con una nota interna que dice cuántas tenía. Si el archivo no trae el contacto, el ticket queda con un solicitante genérico al que no se le envían correos hasta cambiarlo.

**Seguridad (v1.6.2)** — recomendaciones de la revisión de ciberseguridad, detalle en [SECURITY.md](SECURITY.md)
- **Dominios de confianza** para el portal y los correos automáticos (Configuración → General).
- ~~Grupos privados~~: desde la v1.9 no hay grupos y todos los agentes ven todos los tickets.
- Login sin bloqueo del dueño de la cuenta (cookie de dispositivo), CSV sin fórmulas, IA con el texto del usuario marcado como dato y borrador sin contexto interno salvo pedido.

**Cierre de ciclo y calendario (v1.7)**
- **Cierre de ciclo ticket ↔ tareas**: cuando todas las tareas de proyecto vinculadas a un ticket pasan a Finalizado, el ticket recibe una nota privada automática ("🎉 La tarea de desarrollo DEV-42 vinculada a este ticket fue finalizada por @Agente. Ya podés validar y responder al usuario"), se avisa al agente asignado (o a los seguidores si no tiene) y, si el ticket estaba **En espera de desarrollo**, se reabre. Al usuario no se le responde solo. Se configura en Configuración → Proyectos y portfolio → Reglas ticket ↔ proyecto (qué estados cuentan como espera y a qué estado vuelve). La v1.7 agrega el estado "En espera de desarrollo" (pausa el SLA).
- **Roadmap en modo calendario** (Portfolio → Calendario): 12 meses con los proyectos que terminan en cada uno y la carga del mes; al elegir un mes, cada colaborador con todos sus proyectos y las horas que le tocan. Las horas estimadas se reparten parejo por día entre el inicio y el fin del proyecto, y en partes iguales entre el responsable y quienes tienen tareas asignadas. La capacidad para proyectos (por defecto 80 h por persona por mes) la cambia un administrador desde la misma pantalla.

**Base de datos y marca (v1.8)**
- **Explorador de la base de datos** (Configuración → Base de datos, **solo el superadmin**): todas las tablas con su cantidad de registros, búsqueda en todas las columnas, filtro por columna (incluido "es null"), orden y paginado. Con el **Modo edición** prendido se modifican registros (formulario según el tipo de cada columna y confirmación con el antes y el después) y se borran (hasta 200 por vez, escribiendo BORRAR; avisa qué tablas se borran en cascada y no deja borrar algo que otros registros usan). Los valores con flecha llevan al registro relacionado.
  - Cada cambio y cada borrado queda en la auditoría con el valor anterior y una copia de lo borrado.
  - No se muestran: sesiones, límites de intentos y otras tablas técnicas, ni columnas con claves o hashes. La auditoría, las migraciones y las claves de API son de solo lectura; las passkeys y los adjuntos solo se pueden borrar. El usuario superadmin no se modifica desde acá.
  - Los cambios no pasan por las reglas de la aplicación (avisos, SLA, automatizaciones): es para corregir datos puntuales. Antes de un cambio grande, descargá un respaldo.
- **Marca Hanseatica**: isotipo en la barra, el ingreso, el portal, la pantalla de carga y el ícono de la pestaña; logo completo en el ingreso; tipografía **Montserrat**; rojo `#C8102E` y amarillo `#F2A900`. Si cargaste otro logo o colores en Configuración → General, se respetan.

**Sin grupos, nombres de campos y orden por columna (v1.9)**
- **Se eliminaron los grupos.** La categoría técnica (con su subcategoría) es la única clasificación del tema; todos los agentes ven y trabajan todos los tickets. Al publicar, cada ticket pasa su grupo a la categoría técnica equivalente (mismo nombre, o la que es el comienzo del nombre del grupo, ej. "EQUIS - DESARROLLOS - …" → "Equis", y la subcategoría si su nombre aparece en el del grupo). Los que no tienen equivalente aparecen en Configuración → Campos del ticket para asignarlos a mano. Las reglas de automatización que usaban grupos pasan a la categoría técnica; las que no tienen equivalente quedan desactivadas con "(revisar: usaba grupo)". El importador de Desk365 convierte la columna "Grupo" de la misma forma. Se pierde la asignación en turno (round robin).
- **Nombres de los campos editables por el superadmin**: lápiz en cada título de Configuración → Campos del ticket (Estado, Área solicitante, Tipo de ticket, Categoría técnica, Subcategoría técnica) y una tarjeta para los demás (Prioridad, Asignado a, Contacto, Canal, SLA). Se usan en la lista, el detalle, el alta, los filtros, el inicio y los informes.
- **Lista de tickets**: cada columna se ordena tocando su encabezado (▲ ascendente / ▼ descendente). La categoría técnica y el área se cambian directo desde la lista, como la prioridad, el estado y el asignado, y también en las acciones masivas.

**Portal solo con Microsoft y partes configurables (v1.12)**
- **De fábrica, el portal pide ingresar con la cuenta de Microsoft de la empresa**: sin sesión solo se ve la pantalla de ingreso, y ninguna ruta del portal responde (artículos, estado, crear, consultar, mis tickets, ver un ticket). Cada persona ve solo sus tickets; las cuentas invitadas no entran. El enlace "Ver el ticket" de los correos pide ingresar y después vuelve a ese ticket (solo si es de quien ingresó). Sin enlaces de acceso por correo.
- **Configuración → Portal**: mostrar u ocultar el portal, título, acceso (**solo con Microsoft**, recomendado, o **abierto** como antes) y qué partes se muestran: buscador y artículos, estado de los sistemas críticos, consultar un ticket, crear tickets y mis tickets. Cada parte apagada desaparece del menú y del inicio, y su ruta deja de responder. Si Microsoft 365 no está conectado, la pantalla de ingreso avisa con el correo de soporte.
- Los ajustes del portal que estaban en General → Mesa de ayuda pasaron a esta sección.

**Sistemas críticos (v1.11)**
- **Configuración → Sistemas críticos**: la lista de sistemas (CRM, Equis, correo, VPN…), con descripción, orden, si es **público** (se ve en el portal) o solo interno, y opcionalmente el **tema del ticket** relacionado.
- **Inicio de los agentes**: panel arriba de todo con el estado de cada sistema. Tocando uno se informa el problema: **Caído**, **Degradado** o **Mantenimiento**, en cuánto se resuelve (30 min, 1 h, 2 h, 3 h, 4 h, mañana 9 hs u otra hora), un mensaje para los usuarios y los tickets relacionados. Después se actualiza o se marca **Resuelto**; al resolver, se puede responder solo a los solicitantes de los tickets relacionados ("ya funciona normalmente") y dejarlos resueltos. Cada cambio queda en el historial; el equipo recibe una notificación cuando un sistema empieza a fallar y cuando vuelve.
- **Desde un ticket**: "Es un problema de un sistema crítico" lo suma al problema ya informado o abre el aviso para informarlo.
- **Portal público**: debajo del buscador, el estado de los sistemas públicos con el mensaje y la **hora estimada de resolución**; si la hora pasó y nadie la actualizó, dice "Demorado" (y se le avisa a quien lo informó). Al crear un ticket, si el asunto o el tema apuntan a un sistema con un problema informado, se avisa para no repetir el reclamo.
- No es un monitoreo automático: muestra lo que informa la mesa de ayuda. Opciones: ocultarlo del portal, apagar el aviso al crear tickets, y que solo supervisores y administradores puedan informar.

**Portal: consulta por número y "Mis tickets" con Microsoft (v1.10.0 – v1.10.1)**
- **Consultar el estado de un ticket** (inicio del portal y `/portal#/consultar`): número de ticket + correo con el que se abrió (o de alguien en copia). Muestra asunto, estado, fechas, el avance si se convirtió en proyecto y **toda la conversación con el usuario** (sus mensajes y las respuestas de la mesa; nunca las notas internas). Es de solo lectura: para responder o descargar adjuntos hay que ingresar con Microsoft o usar el enlace del correo (v1.10.1). Si el número o el correo no coinciden, el mensaje es siempre el mismo (no se revela qué números existen). Topes: 60 consultas por hora por IP, 20 por correo, y se traban por un rato un número con 10 intentos fallidos o una IP con 20 (quien ingresó con Microsoft no se traba con su ticket).
- **Ingresar con Microsoft** (botón "Ingresar" arriba a la derecha y en Mis tickets): cualquier empleado del tenant de la empresa (no las cuentas invitadas) entra con su cuenta y ve **solo sus tickets**: los de su contacto del directorio (por su id de Entra) y los de contactos sin vincular con su correo principal o su usuario. Si un correo se reasigna a otra persona, la nueva no ve los tickets de la anterior. Puede filtrarlos (abiertos / resueltos / todos), buscarlos, abrir cada uno, responder, adjuntar, marcarlo resuelto y crear tickets nuevos (quedan a su nombre). Con sesión, la consulta por número pide solo el número.
- No da acceso a la mesa de ayuda ni crea agentes: es una sesión aparte del portal (cookie `__Host-hd_portal`, 12 horas). "Anular todos los enlaces del portal" o apagar la opción cierran estas sesiones.
- Usa **la misma app de Entra y el mismo redirect URI** (`/api/auth/ms/callback`) del ingreso de agentes: infraestructura no tiene que registrar nada nuevo. No exige el grupo de agentes.
- Se apaga en **Configuración → General → Mesa de ayuda → "Ingreso con Microsoft en el portal"** (encendido de fábrica; aparece solo con Microsoft 365 configurado).

**Responsable del proyecto (v1.9.9)**
- El **Líder** de la lista de proyectos y el **Responsable** del portfolio son el mismo dato: se elige en Configuración del proyecto → Datos → "Líder (responsable)". Los *miembros* son el equipo.
- Si un proyecto no tiene responsable (por ejemplo, importado con alguien que no es agente), la lista y el portfolio lo marcan "Sin responsable", Configuración lo avisa, y al guardar **un solo miembro** ese miembro queda como responsable.

**Mascota en el inicio de sesión (v1.9.7)**
- El isotipo de Hanseatica cobra vida en la pantalla de ingreso y en la de instalación: mira mientras se escribe el usuario, se tapa los ojos en la clave, espía con un ojo con "Ver clave", frunce el ceño si la clave está mal y pega un saltito al entrar. Archivos del kit sin cambios: `public/js/mascota.js` y `public/css/mascota.css`; la integración está en `public/js/mascota-login.js`.
- Se apaga en **Configuración → General y marca → "Mascota en el inicio de sesión"** (encendida de fábrica). Con la marca de fábrica usa los colores exactos del logo; si cambiás el color principal o el de acento, los sigue.
- Pruebas en navegador: `npm run test:e2e` (la primera vez en tu PC: `npx playwright install chromium`).

**Seguridad (v1.9.6)** — detalle punto por punto en `SECURITY.md`
- Un correo raro ya no traba la entrada de tickets: si falla 3 veces va a la carpeta "Mesa de ayuda - No procesados" del buzón.
- Agentes: papelera/spam de a 10 tickets; combinar y exportar, supervisores o más; sprints, quien configura el proyecto.
- Portal: enlaces de 30 días sin renovación, adjuntos con enlace de 5 minutos y botón para anular todos los enlaces.
- IA sin enlaces ajenos ni teléfonos; el alta desde el portal no reenvía el texto cargado.
- Topes de correos por agente; imágenes externas de los correos bloqueadas hasta "Mostrar imágenes"; logo solo PNG/JPG/WebP; respaldo con escape fijo y passkeys.

**Kanban, etapas en el tablero e ingreso (v1.9.5)**
- **Kanban con tres estados**: Pendiente → En curso → Hecho. Los proyectos Kanban que tenían el flujo original de cuatro estados se actualizan solos al publicar (lo que estaba en "Seleccionado" pasa a "Pendiente"); los flujos que ya se habían personalizado no se tocan.
- **Las etapas del proyecto se ven en el tablero** (por ejemplo Relevamiento y análisis, Desarrollo, Testing e Implementación) como tarjetas con su número, fechas y avance, y se mueven entre estados igual que las tareas. La casilla "Mostrar etapas" las oculta (se recuerda en cada navegador).
- **Ingreso solo con usuario y clave o con Microsoft.** Se quitó el ingreso con passkey (y su sección en Mi perfil). El botón de Microsoft aparece siempre; mientras no esté configurado en Configuración → Microsoft 365, avisa en lugar de llevar a un error. Si algún día se quieren volver a usar passkeys: variable `PASSKEYS_ENABLED=1` en Vercel.

**Convertir un ticket en proyecto: datos obligatorios (v1.9.3)**
- Al convertir un ticket son obligatorios el **inicio de la primera etapa**, el **fin de la última** (v1.9.4), el **origen** y el **sector IT**. Las fechas de las etapas del medio se reparten solas en partes iguales (se ven en gris y se pueden cambiar; si cambiás una, las calculadas se acomodan a continuación). Sin eso no se puede convertir (el formulario marca lo que falta y el servidor también lo rechaza). El alta manual de proyectos no cambia.
- Las fechas del proyecto en "Datos para el portfolio" se toman de las etapas (primer inicio y último fin) y las **horas estimadas se calculan solas**: días hábiles entre el inicio y el fin × horas por día. Se pueden corregir a mano ("Usar el cálculo" vuelve al automático). En el alta manual pasa lo mismo mientras no se escriban las fechas del proyecto a mano.
- **Configuración → Origen, sector IT y horas**: alta, edición (nombre, color, orden), activar/desactivar y baja de orígenes y sectores IT, con la cantidad de proyectos que usa cada uno (los que están en uso no se borran: se desactivan). Ahí también se definen las horas por día hábil para estimar (8 por defecto) y la capacidad mensual por persona del calendario. Los días hábiles y feriados son los del horario de atención.

**Control de fechas (v1.9.2)**
- Ninguna fecha de fin puede quedar antes de su inicio: proyecto, etapas, tareas y sprints. El calendario no deja elegir un fin anterior al inicio y, si igual quedan cruzadas, el campo se pone en rojo con un aviso y no se guarda (el servidor también lo rechaza).
- Etapas: además se avisa si una etapa posterior termina antes de que empiece una anterior (ej. "Implementación termina el 16/10 antes de que empiece Relevamiento el 26/10"), al crear el proyecto y en el Roadmap. Si una etapa cae fuera de las fechas del proyecto se muestra un aviso en amarillo, que no bloquea.
- Los datos viejos con fechas cruzadas no traban otras ediciones: solo se valida cuando se cambia una fecha.

**Filtros de proyectos y configuración con permiso (v1.9.1)**
- **Lista de proyectos con filtros**: búsqueda (nombre, clave, descripción o líder), tipo de proyecto, estado, persona (como líder, integrante o con tareas asignadas) y el atajo "Mis proyectos", prioridad, fechas (atrasados, terminan este mes o en 3 meses, sin fecha), origen, sector IT, área solicitante, con sprint activo e incluir archivados. Orden por nombre, fecha de fin, avance, tareas abiertas o actividad reciente, y vista en tarjetas o lista. Los filtros se recuerdan en cada navegador.
- **Lista del proyecto** (v1.9.8): muestra las etapas y las tareas juntas, agrupadas: cada etapa (con sus fechas) y debajo sus tareas; al final, las tareas sin etapa. Tocando un encabezado se ordena como lista plana ("Agrupar por etapa" vuelve). La casilla "Mostrar etapas" las oculta y se recuerda en cada navegador.
- **Configuración del proyecto solo con permiso**: la ven y la usan el líder del proyecto, supervisores, administradores y los agentes con el permiso nuevo **"Puede configurar todos los proyectos"** (Configuración → Agentes, lo asigna un administrador). Al resto no le aparece la pestaña y el servidor rechaza los cambios.

White-label: nombre, colores y logo desde Configuración → General.

## Superadmin
Cuenta técnica cuyo usuario y clave viven solo en Vercel (`SUPERADMIN_USER`, por defecto `superadmin`, y `SUPERADMIN_PASSWORD`, mínimo 12 caracteres). Ingresa por el mismo login escribiendo el usuario en lugar del correo. Su clave no se puede cambiar desde la app y, si borrás la variable, la cuenta deja de funcionar al instante.

Privilegios exclusivos:
- Crear, modificar, desactivar y eliminar **administradores** (los administradores siguen gestionando agentes y supervisores).
- **Eliminar definitivamente** tickets y **vaciar la papelera** (y el spam viejo).
- **Respaldo** `.sql.gz` portable a cualquier Postgres, con o sin adjuntos (`npm run backup` para bases grandes).
- **Auditoría**: ingresos, intentos fallidos (con IP), cambios de configuración, borrados y respaldos. Nunca guarda claves.
- **Cerrar todas las sesiones** de la organización.
- Estado del sistema y de las variables de Vercel, y actualización del esquema.

No aparece para asignar tickets ni tareas, ni en el round robin, y los administradores no lo ven en la lista de agentes. Si no configurás el superadmin, los administradores conservan la gestión de administradores y el borrado definitivo de tickets; el respaldo, la auditoría y el mantenimiento quedan solo para el superadmin. El login bloquea 15 minutos tras 5 intentos fallidos desde la misma IP.

## Publicar en Vercel + Neon

1. **Neon**: creá un proyecto (región São Paulo, `sa-east-1`) y copiá la *connection string*.
2. **Vercel**: subí la carpeta a un repo de GitHub e importalo (Framework: *Other*, sin build command). Variables de entorno mínimas:
   - `DATABASE_URL` = la cadena de Neon (preferí la *pooled*, con `-pooler` en el host)
   - `SESSION_SECRET` = 32+ caracteres al azar (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`)
   - `SETUP_KEY` = una clave para la instalación (obligatoria en Vercel)
   - `APP_URL` = la URL definitiva, ej. `https://mesa.hanseatica.com` (la usan las passkeys, Microsoft y los enlaces de los correos)
3. Abrí la URL: aparece la **instalación**. Elegí "Hanseatica" (carga áreas, categorías técnicas, estados incl. Stdby y los agentes actuales), el primer número de ticket (por defecto 3500 para seguir después de Desk365) y tu usuario administrador.
4. Los agentes precargados no tienen clave: asignales una temporal en Configuración → Agentes (se les pide cambiarla) o habilitá el ingreso con Microsoft.

Solo usa **1 función serverless** (`api/router.js`), así no hay problema con el tope de 12 del plan Hobby.

En cada despliegue, el build (`npm run vercel-build`) revisa que no haya secretos en el código y aplica las migraciones pendientes antes de que el código nuevo reciba tráfico. Para monitorear: `GET /api/health` (200 sano, 503 sin base).

### Correo saliente (Resend)
`RESEND_API_KEY`, `MAIL_FROM` (dominio verificado en Resend) y opcional `MAIL_REPLY_TO`. Sin esto el sistema funciona igual; los mensajes quedan registrados pero no se envían.

### Correo entrante (Power Automate)
1. Definí `INBOUND_SECRET` en Vercel.
2. Flujo: disparador *Cuando llega un correo nuevo en un buzón compartido (V2)* sobre ayuda@hanseatica.com, con datos adjuntos.
3. Acción HTTP POST a `https://TU-DOMINIO/api/inbound/email`, encabezados `Content-Type: application/json` y `x-inbound-secret: <INBOUND_SECRET>`, cuerpo:
   ```json
   { "From": "@{triggerOutputs()?['body/from']}", "Subject": "@{triggerOutputs()?['body/subject']}",
     "Body": "@{triggerOutputs()?['body/body']}", "Cc": "@{triggerOutputs()?['body/ccRecipients']}",
     "InternetMessageId": "@{triggerOutputs()?['body/internetMessageId']}",
     "Attachments": @{triggerOutputs()?['body/attachments']} }
   ```
Las respuestas con `[#número]` en el asunto se agregan al ticket y lo reabren. Ignora respuestas automáticas y duplicados.

### Microsoft 365 (opcional)
1. App registration en Entra ID (tipo Web) con redirect `https://TU-DOMINIO/api/auth/ms/callback`.
2. Tenant ID (el GUID del directorio, no el dominio) y Client ID en Configuración → Microsoft 365 (o `MS_TENANT_ID` / `MS_CLIENT_ID` en Vercel). El secreto siempre en Vercel: `MS_CLIENT_SECRET` (opcional `MS_CLIENT_SECRET_EXPIRES` para ver el vencimiento).
3. Permisos de **aplicación** de Microsoft Graph según los módulos, con consentimiento de administrador: `Mail.ReadWrite`, `Mail.Send` (buzón), `User.Read.All`, `GroupMember.Read.All` (directorio y grupo de agentes), `DeviceManagementManagedDevices.Read.All` (+ `PrivilegedOperations.All` para acciones remotas), `Sites.ReadWrite.All` (SharePoint). Para limitar el acceso solo al buzón de soporte, usá una *Application Access Policy* de Exchange Online.
4. "Probar conexión" muestra qué permisos están concedidos.
5. Buzón: se lee cuando los agentes usan la app (cada N minutos) y en la tarea diaria. Para leerlo siempre cada minuto, programá un POST a `https://TU-DOMINIO/api/m365/poll` con `x-cron-key: <CRON_SECRET>` (cron-job.org o un flujo "Recurrencia").
6. Teams: en el canal, Workflows → "Publicar en un canal cuando se recibe una solicitud de webhook", y pegá la URL.

### Inteligencia artificial (opcional)
`AI_API_KEY` en Vercel con la clave del proveedor elegido en Configuración → Inteligencia artificial: Anthropic (Claude), Google (Gemini, clave de AI Studio o Vertex) o Azure OpenAI (además `AZURE_OPENAI_ENDPOINT` y el nombre del deployment). La instalación trae cuatro reglas de ejemplo: Correo / Outlook, Desbloqueo de clave, Impresoras y Teams.

### Tarea diaria
`vercel.json` programa `/api/cron/daily` (11:00 UTC). Definí `CRON_SECRET`. Además del autocierre y los avisos de SLA, sincroniza el directorio, lee el buzón y manda el resumen a Teams si esos módulos están activos.

## Desarrollo local
```bash
npm install
npm run dev        # http://localhost:3000 con PGlite (Postgres embebido), sin Neon
npm test           # 82 pruebas end-to-end (incluye 24 de seguridad y 15 de la v1.6; IA y Microsoft 365 simulados)
npm run check:secrets              # busca claves o contraseñas en el código
DATABASE_URL=... npm run migrate:status   # migraciones aplicadas y pendientes
DATABASE_URL=... npm run backup    # respaldo completo a un archivo .sql
DATABASE_URL=... npm run migrate   # crea/actualiza tablas en Neon sin pasar por la instalación
```

## Estructura
```
api/router.js          única función serverless (todas las rutas /api/*)
lib/                   esquema, auth, SLA, correo, lógica de tickets
lib/ai.js              proveedores de IA, reglas, respuesta automática y clasificación
lib/m365.js            Microsoft Graph: buzón, directorio, Teams, Intune, SharePoint
lib/db.js              consultas parametrizadas, pool, transacciones (tx/onCommit), errores 429/503
lib/auth.js            Argon2id, sesiones, tokens; lib/routes/auth.js: login, passkeys, Microsoft
lib/validate.js        esquemas de validación; lib/sanitize.js: HTML seguro
lib/ratelimit.js       límites por IP/cuenta y de concurrencia; lib/idempotency.js: Idempotency-Key
lib/fetchx.js          llamadas externas con timeout y reintentos selectivos; lib/log.js: logs con request id
lib/migrations.js      migraciones versionadas; lib/migrate.js: aplicación con lock
lib/portfolio.js       avance, salud y fechas del portfolio; importación desde Excel
lib/xlsx.js            lectura y escritura de Excel sin dependencias
lib/routes/            core (admin), auth, tickets, projects, portfolio, api (v1), portal (+ inbound, cron, KB), home, ai, m365
public/                SPA de agentes (index.html), portal (portal.html), css, js/views
tests/                 pruebas con PGlite
```

## Límites conocidos
- Adjuntos hasta 3 MB c/u (límite de request de Vercel 4,5 MB); se guardan en Neon o, con el módulo activo, en SharePoint.
- Teams: avisos al canal por webhook; el chat personal a cada agente necesitaría una app de Teams y no está incluido (el agente recibe el aviso en la app y por correo).
- Vercel Hobby solo permite una tarea programada diaria: para leer el buzón cada minuto sin depender del uso de la app, se usa un programador externo contra `/api/m365/poll`.
- La importación de Desk365 trae los datos de cada ticket y su descripción, pero no el historial de respuestas (la exportación de Desk365 no lo incluye).
