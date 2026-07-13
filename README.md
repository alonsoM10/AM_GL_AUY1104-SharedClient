# Evaluación Final Transversal - AUY1104

# Operación Resiliencia en TechMarket

Refactorización del pipeline de CI/CD del microservicio crítico **"Orders"** (aquí representado por `demo-api`), pasando de un `RollingUpdate` sin validaciones a una estrategia **Blue-Green** con validación de salud y rollback automático, sobre un clúster Kubernetes (k3s) sobre AWS.

## Tabla de Contenidos

- [Descripción](#descripción)
- [Objetivos](#objetivos)
- [Arquitectura de la Solución](#arquitectura-de-la-solución)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Función de los Archivos Principales](#función-de-los-archivos-principales)
- [Herramientas Utilizadas](#herramientas-utilizadas)
- [Plantillas Reutilizables](#plantillas-reutilizables)
- [Pipeline CI](#pipeline-ci)
- [Variables de Entorno Dinámicas](#variables-de-entorno-dinámicas)
- [Pipeline CD](#pipeline-cd)
- [Estrategia de Despliegue](#estrategia-de-despliegue)
- [Comparación entre Estrategias](#comparación-entre-estrategias)
- [Justificación de Blue-Green](#justificación-de-blue-green)
- [Mecanismo de Remediación Automática](#mecanismo-de-remediación-automática)
- [Escenarios de Error (evidencia real)](#escenarios-de-error-evidencia-real)
- [Análisis de MTTR, Costo y Uptime](#análisis-de-mttr-costo-y-uptime)
- [Beneficios para el Negocio](#beneficios-para-el-negocio)
- [Nota sobre k3s vs Amazon EKS](#nota-sobre-k3s-vs-amazon-eks)
- [Conclusión](#conclusión)
- [Referencias](#referencias)
- [Declaración de Uso de IA](#declaración-de-uso-de-ia)
- [Integrante](#integrante)

# Descripción

TechMarket detectó que su pipeline de despliegue para el servicio "Orders" era un script básico: aplicaba manifiestos de Kubernetes sin ninguna validación previa, por lo que una versión con errores llegaba directo a los usuarios reales. Este proyecto reemplaza ese pipeline por uno que **construye una versión nueva en paralelo, la valida sin exponerla a tráfico real, y solo mueve el tráfico si la validación pasa** — revirtiendo automáticamente si algo falla.

# Objetivos

## Objetivo General

Implementar un pipeline de CI/CD con GitHub Actions que despliegue el microservicio "Orders" usando una estrategia Blue-Green, con validación de salud automática y rollback ante fallos, sin intervención manual.

## Objetivos Específicos

- Estandarizar el pipeline con plantillas reutilizables (`workflow_call`) compartidas entre repositorios.
- Implementar Blue-Green manipulando el `selector` de un `Service` de Kubernetes para controlar el tráfico.
- Incorporar una etapa de Validación de Salud antes de mover el 100% del tráfico.
- Configurar un mecanismo de rollback automático condicional (`if: failure()`).
- Garantizar auto-recuperación ante fallos inyectados en caliente (Prueba de Fuego), usando probes nativas de Kubernetes.

# Arquitectura de la Solución

```
┌─────────────────────────┐        workflow_call        ┌──────────────────────────────┐
│  SharedClient (este repo)│ ───────────────────────────▶│  SharedCentral                │
│  - src/index.js (API)    │                              │  - deploy-api.yaml (receta)   │
│  - k8s/*.yaml            │                              │  - ea2-lab-dispatch-main.yaml │
│  - client.yaml (trigger) │                              │    (provisiona EC2 + k3s)     │
└─────────────────────────┘                              └──────────────┬────────────────┘
                                                                          │ SSH
                                                                          ▼
                                                          ┌───────────────────────────────┐
                                                          │  EC2 (AWS Learner Lab) + k3s   │
                                                          │  Deployment demo-api-blue      │
                                                          │  Deployment demo-api-green     │
                                                          │  Service demo-api (NodePort)   │
                                                          └───────────────────────────────┘
```

El pipeline se dispara con un `git push` de un tag (`v*.*.*`) en SharedClient, que delega el trabajo pesado (build, push, deploy Blue-Green) a una receta reutilizable en SharedCentral, la cual se conecta por SSH al clúster k3s y manipula los recursos de Kubernetes directamente.

# Estructura del Proyecto

```
AM_GL_AUY1104-SharedClient/
├── .github/workflows/client.yaml     # Dispara el pipeline, delega al central
├── src/index.js                      # API Express con /health, /api/saludo, /api/echo
├── k8s/deployment-template.yaml      # Plantilla con placeholders + probes
├── k8s/service.yaml                  # Service con selector de color (el "switch")
├── tests/app.test.js                 # Test unitario
└── Dockerfile

AM_GL_AUY1104-SharedCentral/
├── .github/workflows/deploy-api.yaml         # Receta reutilizable: tests → build → deploy Blue-Green
├── .github/workflows/ea2-lab-dispatch-main.yaml  # Provisiona EC2 + k3s vía Terraform (Learner Lab)
└── .github/workflows/autorizar-ssh.yaml      # Utilidad para autorizar acceso SSH personal
```

# Función de los Archivos Principales

| Archivo | Función |
|---|---|
| `client.yaml` | Trigger por tag, delega vía `workflow_call` a `deploy-api.yaml`, pasa `image-name`, `image-tag`, `namespace`, `app-env` |
| `deploy-api.yaml` | Receta reutilizable: corre tests, construye y publica la imagen Docker, y ejecuta el despliegue Blue-Green completo |
| `deployment-template.yaml` | Plantilla con `${COLOR}`, `${IMAGE}`, `${APP_ENV}`, `${NAMESPACE}` renderizada con `envsubst` antes de aplicarse; incluye `readinessProbe`/`livenessProbe` contra `/health` |
| `service.yaml` | Define el `Service` NodePort cuyo `selector.color` decide qué versión recibe el tráfico real |
| `src/index.js` | Expone `/health` con el color, entorno y versión actual, usado por la validación de salud del pipeline |

# Herramientas Utilizadas

- **GitHub Actions** — orquestación del pipeline (`workflow_call`, `workflow_dispatch`)
- **Docker / Docker Hub** — construcción y almacenamiento de imágenes (`docker/login-action@v3`)
- **Kubernetes (k3s)** — orquestador de contenedores, corriendo sobre una instancia EC2 del AWS Learner Lab
- **Terraform** (receta del curso `asanchezo-duoc/AUY1104-SharedWorkflows`) — provisiona la instancia EC2 e instala k3s
- **webfactory/ssh-agent@v0.9.0** — maneja la llave SSH dentro del runner de GitHub Actions para conectarse al clúster
- **envsubst** — renderiza la plantilla de Kubernetes sustituyendo variables de entorno

# Plantillas Reutilizables

`deploy-api.yaml` está definido con `on: workflow_call`, lo que lo convierte en una plantilla que cualquier repositorio cliente puede invocar pasando solo sus propios `inputs` (`image-name`, `image-tag`, `k3s-server-public-ip`, `namespace`, `app-env`) y `secrets`. Esto evita reescribir la lógica de build/deploy en cada microservicio de TechMarket — un segundo servicio solo necesitaría su propio `client.yaml` de unas 15 líneas.

# Pipeline CI

Job `deps-and-test` → `build-and-push` en `deploy-api.yaml`: instala dependencias, corre `npm test`, y si pasa, construye la imagen Docker y la publica en Docker Hub con dos tags (`vX.Y.Z` y `latest`).

# Variables de Entorno Dinámicas

El pipeline inyecta variables sin tocar código fuente, en dos niveles:

1. **A nivel de pipeline**: `namespace` y `app-env` son `inputs` del `workflow_call`, con valores por defecto (`default`, `prod`) que se pueden sobrescribir desde `client.yaml` sin modificar `deploy-api.yaml`.
2. **A nivel de contenedor**: `APP_COLOR`, `APP_ENV`, `APP_VERSION` se inyectan como variables de entorno en el pod (vía la plantilla renderizada) y la aplicación las expone en `/health` — así se puede verificar en vivo qué versión/color está respondiendo, sin entrar al clúster.

# Pipeline CD

El job `deploy-to-k8s` (11 pasos, ver `deploy-api.yaml`) ejecuta el despliegue Blue-Green completo: detecta el color activo, renderiza la plantilla, asegura el `Service`, despliega el color inactivo, valida su salud, mueve el tráfico, vuelve a validar, y revierte automáticamente si algo falla.

# Estrategia de Despliegue

Se implementó **Blue-Green**: dos `Deployments` completos (`demo-api-blue`, `demo-api-green`) coexisten en el clúster. Solo uno recibe tráfico real, decidido por el `selector.color` del `Service`. El flujo:

1. Se identifica el color activo (`kubectl get service ... -o jsonpath`).
2. Se despliega la nueva versión en el color inactivo — sin tocar el tráfico real.
3. Se valida su salud en dos capas (ver sección de remediación).
4. Si pasa, se hace `kubectl patch` al `selector` del `Service` → el tráfico se mueve al 100% de forma instantánea.
5. Si falla en cualquier punto antes o después del switch, se revierte el `selector` al color anterior y se escala a 0 el color roto.

# Comparación entre Estrategias

| Estrategia | Disponibilidad | Riesgo | Rollback |
|---|---|---|---|
| All-in-Once | Baja | Alto | Difícil (redeploy manual completo) |
| Rolling Update | Media | Medio | Medio (usuarios ya vieron pods nuevos antes de detectar el fallo) |
| Canary | Alta | Bajo | Rápido, pero requiere split de tráfico por peso (ingress/mesh) |
| **Blue-Green (elegida)** | **Muy alta** | **Muy bajo** | **Inmediato** (solo cambia un `selector`, sin redeploy) |

# Justificación de Blue-Green

"Orders" es un servicio crítico: no puede permitirse que un usuario real reciba una versión rota. Blue-Green es la única estrategia que garantiza **cero exposición de tráfico real** durante la validación — la versión nueva se prueba de forma aislada, y el tráfico solo se mueve cuando ya se demostró que funciona. Se descartó Canary porque, aunque también es válida y de bajo riesgo, exige que una fracción del tráfico real toque la versión nueva desde el principio, y requiere infraestructura de split de tráfico por peso que el clúster actual (Service simple, sin Ingress/mesh) no tiene.

# Mecanismo de Remediación Automática

Flujo: **Detección → Acción → Notificación**

1. **Detección**: dos capas de Health Check.
   - Nativa de Kubernetes: `readinessProbe`/`livenessProbe` contra `/health` (cada pod debe responder 200 para considerarse listo).
   - De negocio: el pipeline compara el campo `color` del cuerpo JSON contra el color que se acaba de desplegar (paso 7 y 9 de `deploy-api.yaml`).
2. **Acción**: si la validación falla, el step `10 · Rollback automático` (`if: failure()`) revierte el `selector` del `Service` al color estable anterior y escala a 0 el `Deployment` roto.
3. **Notificación**: los logs del step usan `::error::` para que GitHub Actions marque el fallo explícitamente en el resumen del run, y el step `11 · Estado final del clúster` (`if: always()`) deja constancia del estado de pods y Service tras cualquier resultado.

Para fallos que ocurren **fuera** del pipeline (en caliente, como la Prueba de Fuego), la remediación es nativa de Kubernetes: la `livenessProbe` reinicia contenedores colgados, y el `ReplicaSet` repone automáticamente cualquier pod eliminado.

# Escenarios de Error (evidencia real)

| # | Escenario | Resultado | Evidencia |
|---|---|---|---|
| 1 | Primer despliegue (color blue) | Éxito | [Run #14](https://github.com/alonsoM10/AM_GL_AUY1104-SharedClient/actions/runs/29221004125) |
| 2 | Nueva versión + switch de tráfico a green | Éxito | [Run #15](https://github.com/alonsoM10/AM_GL_AUY1104-SharedClient/actions/runs/29221298562) |
| 3 | `/health` devuelve un color incorrecto (fallo de validación simulado) | **Rollback automático exitoso**, tráfico real nunca se movió | [Run #16](https://github.com/alonsoM10/AM_GL_AUY1104-SharedClient/actions/runs/29222165729) (falla intencionalmente en el paso 7) |
| 4 | Corrección y redeploy | Éxito | [Run #17](https://github.com/alonsoM10/AM_GL_AUY1104-SharedClient/actions/runs/29222392584) |
| 5 | `kubectl delete pod` sobre un pod activo (en caliente) | El `ReplicaSet` repuso el pod en segundos, sin caída de servicio | Prueba de Fuego, en vivo por SSH |
| 6 | `kubectl set image` con tag inexistente sobre el color activo (en caliente) | Pod nuevo quedó en `ErrImagePull`, pods viejos siguieron sirviendo; recuperado con `kubectl rollout undo` | Prueba de Fuego, en vivo por SSH |

Otros escenarios de error relevantes para EKS/k3s que este diseño cubre: `CrashLoopBackOff` (lo detiene la `livenessProbe`), fallo de `readinessProbe` (el pod nunca recibe tráfico, no afecta a los usuarios), y error 500/latencia alta en el health check de negocio (detectado en el paso 7/9, dispara rollback).

# Análisis de MTTR, Costo y Uptime

- **MTTR (Mean Time To Recovery)**: en la prueba real (Run #16), la validación de salud detectó el fallo en **7 segundos** y el rollback automático se completó en **4 segundos** — recuperación total en **~11 segundos**, sin intervención humana. Un rollback manual típico requiere que alguien note el problema (minutos a horas) y ejecute los comandos correctos.
- **Costo**: durante la ventana de despliegue, el clúster corre temporalmente el doble de pods (color activo + color en validación) — mayor consumo de CPU/memoria, pero solo por los segundos que dura el despliegue, no de forma permanente.
- **Uptime**: 100% en las seis pruebas realizadas — en ningún escenario (incluidos los fallos intencionales) el tráfico real quedó sin servicio.

# Beneficios para el Negocio

Reduce el riesgo de que un despliegue defectuoso llegue a clientes reales de TechMarket, lo que se traduce en menos incidentes de caída de servicio y menos tiempo de ingeniería gastado en diagnosticar y revertir manualmente. Al estar parametrizado (namespace, entorno, imagen), el mismo pipeline puede reusarse para otros microservicios del sistema sin trabajo adicional, acelerando el time-to-market de futuras funcionalidades.

# Nota sobre k3s vs Amazon EKS

El enunciado de la EFT especifica Amazon EKS/ECR. Este proyecto usa **k3s sobre una instancia EC2 del AWS Learner Lab** (provisionada vía Terraform) y Docker Hub, consistente con la infraestructura usada durante todo el semestre. Técnicamente esto no afecta la validez de los indicadores evaluados: k3s es una distribución completa y conforme de Kubernetes (misma API, mismo `kubectl`), por lo que toda la lógica de `Service`/`selector`, probes, y rollback es idéntica a la que se usaría en EKS. La sustitución se debe a las restricciones del Learner Lab (sin acceso a crear clústeres EKS) y fue consultada con el docente.

# Conclusión

El pipeline pasó de aplicar manifiestos a ciegas a ejecutar un despliegue Blue-Green completo, con validación de salud en dos capas y rollback automático probado en condiciones reales (incluyendo fallos inyectados en caliente). El servicio "Orders" ahora puede recibir nuevas versiones sin arriesgar el tráfico real de los usuarios.

# Referencias

Fowler, M. (2010). *BlueGreenDeployment*. martinfowler.com. https://martinfowler.com/bliki/BlueGreenDeployment.html

Kubernetes. (s. f.). *Deployments*. Kubernetes Documentation. Recuperado el 13 de julio de 2026, de https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

Kubernetes. (s. f.). *Configure Liveness, Readiness and Startup Probes*. Kubernetes Documentation. Recuperado el 13 de julio de 2026, de https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/

GitHub. (s. f.). *Reusing workflows*. GitHub Docs. Recuperado el 13 de julio de 2026, de https://docs.github.com/actions/using-workflows/reusing-workflows

# Declaración de Uso de IA

Se utilizó Claude (Anthropic), a través de Claude Code, como asistente técnico durante el desarrollo de este proyecto, apoyando en: la redacción de la plantilla de despliegue Blue-Green y las probes de Kubernetes, la lógica del workflow `deploy-api.yaml`, la depuración de errores de configuración (credenciales de Docker Hub, acceso SSH al clúster) y la redacción de este README a partir del código y las pruebas ya ejecutadas. Las decisiones de arquitectura y estrategia fueron validadas por el estudiante, quien ejecutó directamente los commits, despliegues, pruebas de fallo y la Prueba de Fuego en el clúster.

# Integrante

Alonso Mieres — Duoc UC — AUY1104, Ciclo de Vida del Software II
