import type { ReactNode } from "react"

export default function Layout({ children }: { readonly children?: ReactNode }) {
  return (
    <div>
      <nav>
        <a href="/away">away</a> <a href="/light">light</a>
        {["list", "plain", "fresh"].flatMap((route) =>
          [1, 2, 3].map((n) => (
            <a key={`${route}${n}`} href={`/${route}/${n}`}>
              {route} {n}
            </a>
          )),
        )}
      </nav>
      <main>{children}</main>
    </div>
  )
}
