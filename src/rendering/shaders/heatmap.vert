varying vec2 vWorldPos;

void main() {
  vWorldPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
