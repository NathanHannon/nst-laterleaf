import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { RateLimitExceededFilter } from './common/rate-limit/rate-limit-exceeded.filter';

async function bootstrap() {
  // `rawBody: true` populates `req.rawBody` (the exact bytes received) on
  // every request, needed by the Clerk webhook handler to verify the svix
  // signature (JSON.stringify(req.body) would not byte-match what Clerk signed).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // Mirrors lb-laterleaf's `rest.basePath: '/api'` config.
  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.useGlobalFilters(new RateLimitExceededFilter());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
