<script>
  import { useLocale, useT } from "../../src/i18n.ts"

  const key = useLocale()
  const { locale } = useT()
</script>

<p>{key()}|{locale}</p>
