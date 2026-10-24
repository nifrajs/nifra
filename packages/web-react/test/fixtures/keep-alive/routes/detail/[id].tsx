import { useParams } from "@nifrajs/web-react/router"

export default function Detail() {
  return <p className="detail">Detail {useParams().id}</p>
}
