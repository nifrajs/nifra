import logo from "../logo.svg"
import styles from "./about.module.css"

export default function About() {
  return [styles.card, styles.badge, logo].join(" ")
}
