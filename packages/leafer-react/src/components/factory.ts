import { createElement, type ReactNode } from 'react'

type ComponentFunction<P> = (props: P) => any

interface DefineOptions<P> {
  transform?: (props: P) => any
}

/**
 * Create a typed React component for a Leafer element.
 * The reconciler's createInstance() will match the tag string
 * to the element registry and create the Leafer instance.
 */
export function defineLeaferElement<P = any>(
  tag: string,
  options?: DefineOptions<P>
): ComponentFunction<P & { children?: ReactNode }> {
  function Component(props: P & { children?: ReactNode }): any {
    const { children, ...rest } = props as any
    const transformed = options?.transform ? options.transform(rest) : rest

    if (
      transformed &&
      typeof transformed === 'object' &&
      'tag' in transformed &&
      'props' in transformed
    ) {
      return createElement(transformed.tag, transformed.props, children)
    }
    return createElement(tag, transformed, children)
  }

  Component.displayName = tag.charAt(0).toUpperCase() + tag.slice(1)
  return Component
}
