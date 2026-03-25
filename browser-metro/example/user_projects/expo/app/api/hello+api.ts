export function GET(request: Request) {
  return Response.json({
    message: "Hello from the API!",
    timestamp: new Date().toISOString(),
    url: request.url,
  });
}

export function POST(request: Request) {
  return request.json().then((body: unknown) => {
    return Response.json({
      message: "Received POST data",
      data: body,
    });
  });
}
