export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
  }
}
export const badRequest = (m: string, code = 'bad_request') => new HttpError(400, m, code);
export const forbidden = (m = 'Недостаточно прав') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Не найдено') => new HttpError(404, m, 'not_found');
export const unauthorized = (m = 'Требуется вход') => new HttpError(401, m, 'unauthorized');
