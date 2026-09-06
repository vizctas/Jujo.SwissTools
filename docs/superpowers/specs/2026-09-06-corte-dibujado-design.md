# Corte dibujado — diseño

Taller 3D. Dos gestos nuevos para decir dónde cortar dibujando sobre el lienzo:
el **cuchillo** (un trazo que inclina el plano) y el **lazo** (un contorno que
sustituye al rectángulo del recorte). Combinables: se inclina y luego se dibuja
la región.

## Por qué

El recorte rectangular por eje resolvió «cortar el brazo sin tocar lo que hay
detrás», pero un rectángulo alineado con los ejes es tosco: un brazo torcido
necesita un plano inclinado, y una región con forma necesita un contorno. Dibujar
es el gesto más directo que hay para las dos cosas.

## Decisiones

- **Un solo plano `normal + offset`.** Se elimina la distinción eje/libre. Los
  botones X/Y/Z ponen la normal sobre un eje; el cuchillo pone cualquiera.
  Todos los consumidores (worker, gizmo, apuntar, mover, extremidades) tienen
  un camino.
- **Cuchillo recto.** El trazo se reduce a su inicio y su fin. La cara de corte
  es plana: se imprime bien y los conectores se planifican como hoy. Un trazo
  curvo se queda fuera.
- **El lazo vive en el marco del plano.** Coordenadas (u, v) sobre el plano, no
  ejes del mundo. Así funciona igual sobre un plano por eje o inclinado.
- **El contorno se redibuja, no se edita.** Sin vértices arrastrables. Dibujar
  otra vez reemplaza el anterior.
- **Un contorno por corte.** Varios a la vez, fuera.

## Estado del corte

```ts
interface CutState {
  /** Normal unitaria del plano, en coordenadas de la pieza. */
  normal: Vec3;
  /** Fracción 0–1 a lo largo de la normal, entre el mínimo y el máximo de la
   *  caja de la pieza proyectada sobre ella. */
  position: number;
  window: CutWindow | null;
}

interface CutWindow {
  /** En el marco del plano (u, v). */
  center: [number, number];
  size: [number, number];
  side: 1 | -1;
  depth?: number | null;
  /** Contorno cerrado en (u, v). `null` o ausente = el rectángulo de center/size. */
  outline?: [number, number][] | null;
}
```

Con `outline`, `center` y `size` son la caja del contorno y se mantienen al
día: el gizmo, los sliders de ancho/alto y el arrastre siguen leyéndolos.
Arrastrar la ventana traslada el contorno entero. Cambiar `size` con un contorno
presente lo descarta y vuelve al rectángulo (es lo que el usuario está pidiendo
al tocar ancho/alto).

`Plane` del protocolo sigue siendo `{ normal, offset, window }`; deja de exigir
normales sobre un eje.

## Marco del plano

`planeBasis(normal): { u: Vec3; v: Vec3 }`, pura, en `joints.ts`:

- `v` = Z del mundo proyectado sobre el plano y normalizado, para que «alto» sea
  arriba en cualquier inclinación. Si la normal es (casi) Z, `v` = Y del mundo.
- `u = v × n`.

`frame(normal)` deja los Euler y pasa a `Manifold.transform` con la matriz
`[u v n]`: el marco alineado del worker y el del gizmo son el mismo por
construcción. Para Z y X el rectángulo de hoy queda idéntico (`(x, y)` y
`(y, z)`); para Y, `u = −x`: se invierte un signo que el gizmo absorbe.

`windowColumn` se construye directamente en el marco alineado (el plano es
`z = offset`): `cube([w, h, reach])` o `extrude(CrossSection([outline], 'EvenOdd'), reach)`,
trasladado a `[cu, cv, offset]` (o `offset − reach` con `side = −1`). `cutOnce`
deja de rotar la columna.

## Gestos

Dos botones junto a «Apuntar» en la tarjeta de corte, con su badge en el lienzo
y Esc para cancelar. Los dos apagan la órbita mientras dura el trazo y tratan
ratón, dedo y lápiz igual (pointer events).

**Cuchillo (C).** Un trazo; se queda con el primer y el último punto. Los rayos
de la cámara (perspectiva) por esos dos puntos definen el plano que los
contiene: `n = normalize(d0 × d1)`, `offset = n · cámara`, ambos pasados a
coordenadas de la pieza restando su colocación. La normal se orienta con la
componente dominante positiva para que «Lado» no cambie de sentido al azar.
`position` se deriva del offset. Dos puntos a menos de 4 px, o rayos paralelos,
se ignoran y el modo sigue activo. Al terminar, el modo se apaga.

**Dibujar (D).** Solo con Recorte activo. Cada punto del trazo se proyecta con
el rayo de la cámara sobre el plano actual, se pasa a (u, v) y se acumula;
puntos a menos de 3 px del anterior se descartan. Al soltar, se cierra. Menos de
tres puntos se ignora y el modo sigue activo. Al terminar, el modo se apaga.

**Tarjeta.** Cuando la normal no cae sobre un eje, el segmentado X/Y/Z no marca
ninguno y aparece «Plano libre · 23° respecto a Z». Pulsar un eje endereza y
conserva `position`. Los sliders del recorte se etiquetan «Ancho» y «Alto»
siempre (ya no llevan letra de eje).

**Gizmo.** El plano se orienta con `planeBasis` en vez de con el eje. Con
contorno, el relleno visible es un `ShapeGeometry` del contorno y las aristas
su perímetro; el rectángulo de arrastre sigue siendo la caja.

## Extremidades

`findAppendages` sigue barriendo por ejes y devolviendo `axis`. Construye la
ventana con `planeBasis` de ese eje para que `useAppendage` la use sin
convertir: `useAppendage` pone `normal` del eje y `position` del offset.

## Errores

- Plano que no alcanza material a los dos lados: el camino de hoy («no hay
  corte», la pieza se devuelve intacta).
- Contorno autointersecado: `EvenOdd` lo resuelve; nunca falla.
- Extrusión vacía (contorno degenerado que Clipper reduce a nada): se trata como
  «no hay corte».

## Pruebas (self-checks)

`src/tools/mesh/stroke.ts` puro, sin three.js, con su self-check:

- `planeFromRays(origin, d0, d1)`: dos rayos desde el frente que dibujan una
  línea horizontal dan normal ≈ Z; una vertical, normal ≈ X; paralelos → `null`.
- `simplify(points, minDistance)`: descarta los cercanos, conserva el último.
- `orient(normal)`: la componente dominante sale positiva.

En `selfcheck-joints.ts`:

- `planeBasis`: ortonormal, `u × v = n`, `v` con Z positivo para una normal
  inclinada, `(x, y)` para Z y `(y, z)` para X.
- `frame` coincide con `planeBasis`: un cubo desplazado, transformado con
  `forward`, tiene su centro en `(c·u, c·v, c·n)`.
- Columna con contorno: un triángulo de 10×10 sobre un cubo de 20 mm, corte por
  Z en el medio; la pieza separada mide `50 · 10 = 500 mm³`.

## Fuera

Trazo curvo, edición del contorno por vértices, varios contornos, cámara
ortográfica, deshacer.
