import { useParams } from 'react-router-dom';

export function ProjectDetailPage() {
  const { id } = useParams();
  return (
    <div className="dash-head">
      <h3>Project {id}</h3>
    </div>
  );
}
