import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { RateLimitExceededFilter } from './common/rate-limit/rate-limit-exceeded.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // `rawBody: true` populates `req.rawBody` (the exact bytes received) on
  // every request, needed by the Clerk webhook handler to verify the svix
  // signature (JSON.stringify(req.body) would not byte-match what Clerk signed).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // The extension posts full article content + HTML, which blows past body-parser's 100kb default.
  app.useBodyParser('json', { limit: '5mb' });
  app.useBodyParser('urlencoded', { limit: '5mb', extended: true });
  // Mirrors lb-laterleaf's `rest.basePath: '/api'` config.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const corsOrigins = process.env.CORS_ALLOWED_ORIGINS
    ?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (corsOrigins && corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  } else {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('CORS_ALLOWED_ORIGINS is not set; allowing all origins.');
    }
    app.enableCors();
  }

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.useGlobalFilters(new RateLimitExceededFilter());
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
