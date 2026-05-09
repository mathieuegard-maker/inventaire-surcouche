export default function handler(request: any, response: any) {
  response.status(200).json({
    message: "Le proxy Vercel est prêt et fonctionne !"
  });
}