<script>
  let {
    size = 18,
    color = 'currentColor',
    strokeWidth = 2,
    fill = 'none',
    class: className = '',
    children
  } = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  {fill}
  stroke={fill === 'none' ? color : 'none'}
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  style={`min-width: ${size}px; min-height: ${size}px; width: ${size}px; height: ${size}px;`}
>
  {@render children()}
</svg>
