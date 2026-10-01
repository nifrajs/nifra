<script>
  import { useT } from "../../src/i18n.ts"

  const { t } = useT()
</script>

<p>{t("own")}|{t("greeting", { name: "Ada", n: 12 })}|{t("gone")}</p>
